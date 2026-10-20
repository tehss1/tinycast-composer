import AppKit
import ImageIO
import UniformTypeIdentifiers
import Synchronization

struct Screenshot: Codable {
    var png: String
    var pixelWidth: Int
    var pixelHeight: Int
    var displayWidth: Double
    var displayHeight: Double

    var previewPNG: String?

    static func read(from pasteboard: NSPasteboard) throws -> Screenshot? {
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let filenames = pasteboard.propertyList(forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")) as? [String] ?? []
        for path in urls.map(\.absoluteString) + filenames {
            if let image = try? readFile(path) { return image }
        }
        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            if let data = pasteboard.data(forType: type), let image = try? fitted(data) { return image }
        }
        if let path = pasteboard.string(forType: .string), let image = try? readFile(path) { return image }
        return try promisedImage(from: pasteboard)
    }

    static func readFile(_ path: String) throws -> Screenshot? {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if let quote = value.first, ["\"", "'"].contains(String(quote)), value.last == quote {
            value = String(value.dropFirst().dropLast())
        }
        let url: URL
        if value.hasPrefix("file://") {
            guard let file = URL(string: value), file.isFileURL,
                file.host == nil || file.host == "" || file.host == "localhost"
            else { return nil }
            url = file
        } else {
            guard value.hasPrefix("/") || value.hasPrefix("~/") else { return nil }
            url = URL(fileURLWithPath: (value as NSString).expandingTildeInPath)
        }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size <= 64_000_000,
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let type = CGImageSourceGetType(source), UTType(type as String)?.conforms(to: .image) == true
        else { return nil }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return try fitted(data, fallbackDPI: url.deletingPathExtension().lastPathComponent.hasSuffix("@2x") ? 144 : 72)
    }

    static func promisedImage(from pasteboard: NSPasteboard) throws -> Screenshot? {
        guard let receivers = pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self]) as? [NSFilePromiseReceiver],
            !receivers.isEmpty
        else { return nil }
        return try receivePromises(receivers)
    }

    static func receivePromises(_ receivers: [NSFilePromiseReceiver]) throws -> Screenshot? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("composer-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let result = Mutex<(image: Screenshot?, completed: Int)>((nil, 0))
        let queue = OperationQueue()
        for receiver in receivers {
            receiver.receivePromisedFiles(atDestination: directory, options: [:], operationQueue: queue) { url, error in
                let image = error == nil ? try? Self.readFile(url.path) : nil
                result.withLock { state in
                    state.image = state.image ?? image
                    state.completed += 1
                }
            }
        }
        let deadline = Date(timeIntervalSinceNow: 2)
        while Date() < deadline {
            if result.withLock({ $0.image != nil || $0.completed >= receivers.count }) { break }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
        }
        return result.withLock { $0.image }
    }

    static func fitted(_ data: Data, fallbackDPI: Double = 72) throws -> Screenshot {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
            let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
            width > 0, height > 0, width * height <= 100_000_000
        else { throw ScreenshotError.invalidImage }
        let dpi = (properties[kCGImagePropertyDPIWidth] as? NSNumber)?.doubleValue ?? fallbackDPI
        let naturalWidth = width * 72 / max(72, dpi)
        var displayWidth = min(640, naturalWidth)
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ] as CFDictionary) else { throw ScreenshotError.invalidImage }
        let ratio = Double(thumbnail.height) / Double(thumbnail.width)
        var pixelWidth = min(thumbnail.width, Int(ceil(displayWidth * 2)))
        var pixelHeight = max(1, Int((Double(pixelWidth) * ratio).rounded()))
        while pixelWidth > 0 {
            displayWidth = min(displayWidth, Double(pixelWidth))
            let displayHeight = displayWidth * Double(pixelHeight) / Double(pixelWidth)
            let image = try scaled(thumbnail, width: pixelWidth, height: pixelHeight)
            let png = try encoded(image, type: UTType.png, displayWidth: displayWidth)
            if png.count <= 4_500_000 {
                let scale = min(1, min(640 / Double(pixelWidth), 400 / Double(pixelHeight)))
                let preview = try scaled(image, width: max(1, Int(Double(pixelWidth) * scale)), height: max(1, Int(Double(pixelHeight) * scale)))
                return Screenshot(
                    png: png.base64EncodedString(), pixelWidth: pixelWidth, pixelHeight: pixelHeight,
                    displayWidth: displayWidth, displayHeight: displayHeight,
                    previewPNG: try encoded(preview, type: .png, displayWidth: displayWidth).base64EncodedString())
            }
            pixelWidth = Int(Double(pixelWidth) * 0.8)
            pixelHeight = max(1, Int((Double(pixelWidth) * ratio).rounded()))
        }
        throw ScreenshotError.invalidImage
    }

    static func scaled(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw ScreenshotError.invalidImage }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let result = context.makeImage() else { throw ScreenshotError.invalidImage }
        return result
    }

    static func encoded(_ image: CGImage, type: UTType, displayWidth: Double) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil)
        else { throw ScreenshotError.invalidImage }
        let dpi = Double(image.width) * 96 / displayWidth
        CGImageDestinationAddImage(destination, image, [
            kCGImagePropertyDPIWidth: dpi,
            kCGImagePropertyDPIHeight: dpi,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ScreenshotError.invalidImage }
        return data as Data
    }

    func representations() throws -> (png: Data, tiff: Data) {
        guard let data = Data(base64Encoded: png),
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
            displayWidth.isFinite, displayWidth > 0, displayWidth <= 640,
            displayHeight.isFinite, displayHeight > 0,
            pixelWidth == image.width, pixelHeight == image.height
        else { throw ScreenshotError.invalidImage }
        return (data, try Self.encoded(image, type: .tiff, displayWidth: displayWidth))
    }

}

enum ScreenshotError: LocalizedError {
    case invalidImage
    case unavailableTarget
    case noAccessibility
    case changedClipboard
    case pasteboardWrite
    case keyboardEvent

    var errorDescription: String? {
        switch self {
        case .invalidImage: "The clipboard image couldn't be decoded or resized."
        case .unavailableTarget: "The original app is no longer focused. Paste stopped."
        case .noAccessibility: "Tinycast needs Accessibility access to paste the screenshot."
        case .changedClipboard: "The clipboard changed during delivery. Paste stopped."
        case .pasteboardWrite: "Couldn't write the draft to the clipboard."
        case .keyboardEvent: "Couldn't create the paste keystroke."
        }
    }
}

struct ScreenshotDelivery: Decodable {
    let bundleId: String
    let before: String
    let after: String
    let image: Screenshot

    func pasteboardItem() throws -> NSPasteboardItem {
        let data = try image.representations()
        let before = before.isEmpty || before.hasSuffix("\n") ? before : before + "\n\n"
        let after = after.isEmpty || after.hasPrefix("\n") ? after : "\n\n" + after
        let file = FileWrapper(regularFileWithContents: data.tiff)
        file.preferredFilename = "screenshot.tiff"
        let attachment = NSTextAttachment(fileWrapper: file)
        attachment.bounds = CGRect(x: 0, y: 0, width: image.displayWidth * 0.75, height: image.displayHeight * 0.75)
        let rich = NSMutableAttributedString(string: before)
        rich.append(NSAttributedString(attachment: attachment))
        rich.append(NSAttributedString(string: after))
        let rtfd = try rich.data(from: NSRange(location: 0, length: rich.length), documentAttributes: [
            .documentType: NSAttributedString.DocumentType.rtfd,
        ])
        let width = Int(image.displayWidth.rounded())
        let height = max(1, Int(image.displayHeight.rounded()))
        let html = "<html><head><meta charset=\"utf-8\"></head><body>" +
            Self.htmlText(before) +
            "<img src=\"data:image/png;base64,\(image.png)\" width=\"\(width)\" height=\"\(height)\" " +
            "style=\"width:\(width)px;height:\(height)px;max-width:100%;\" alt=\"Screenshot\">" +
            Self.htmlText(after) + "</body></html>"
        let item = NSPasteboardItem()
        item.setData(rtfd, forType: .rtfd)
        item.setString(html, forType: .html)
        item.setString(before + after, forType: .string)
        return item
    }

    static func htmlText(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\n", with: "<br>")
    }
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            })
        }
    }

    func restore(to pasteboard: NSPasteboard, ifUnchanged changeCount: Int) {
        guard pasteboard.changeCount == changeCount else { return }
        pasteboard.clearContents()
        let restored = items.map { representations in
            let item = NSPasteboardItem()
            for (type, data) in representations { item.setData(data, forType: type) }
            return item
        }
        if !restored.isEmpty { pasteboard.writeObjects(restored) }
    }
}

@MainActor
func pasteScreenshot(_ delivery: ScreenshotDelivery) throws {
    guard AXIsProcessTrusted() else { throw ScreenshotError.noAccessibility }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: delivery.bundleId).first
    else { throw ScreenshotError.unavailableTarget }
    let item = try delivery.pasteboardItem()
    let source = CGEventSource(stateID: .combinedSessionState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
    else { throw ScreenshotError.keyboardEvent }
    for event in [down, up] {
        event.flags = .maskCommand
        event.setIntegerValueField(.eventSourceUserData, value: 0x54494E59)
    }
    let pasteboard = NSPasteboard.general
    let snapshot = PasteboardSnapshot(pasteboard)
    let initialChange = pasteboard.changeCount
    var ownedChange: Int?
    defer {
        if let ownedChange { snapshot.restore(to: pasteboard, ifUnchanged: ownedChange) }
    }
    guard app.activate() else { throw ScreenshotError.unavailableTarget }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.35))
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    else { throw ScreenshotError.unavailableTarget }
    item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
    item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
    guard pasteboard.changeCount == initialChange else { throw ScreenshotError.changedClipboard }
    pasteboard.clearContents()
    ownedChange = pasteboard.changeCount
    guard pasteboard.writeObjects([item]) else { throw ScreenshotError.pasteboardWrite }
    ownedChange = pasteboard.changeCount
    down.postToPid(app.processIdentifier)
    up.postToPid(app.processIdentifier)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))
}

@MainActor
func screenshotCommand(pasting: Bool, fromFile: Bool = false) -> Never {
    do {
        if pasting {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            try pasteScreenshot(JSONDecoder().decode(ScreenshotDelivery.self, from: data))
            emit(["status": "ok"])
        }
        let screenshot: Screenshot?
        if fromFile {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            let path = try JSONDecoder().decode(String.self, from: input)
            screenshot = try Screenshot.readFile(path)
        } else {
            screenshot = try Screenshot.read(from: .general)
        }
        guard let screenshot else { emit(["status": "empty"]) }
        FileHandle.standardOutput.write(try JSONEncoder().encode(ScreenshotReply(status: "ok", image: screenshot)))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data(error.localizedDescription.utf8))
        exit(4)
    }
}

struct ScreenshotReply: Encodable {
    let status: String
    let image: Screenshot
}
