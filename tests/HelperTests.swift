import AppKit
import ImageIO
import UniformTypeIdentifiers

func emit(_ object: [String: Any]) -> Never { fatalError("Not used by tests") }

final class PromiseFixture: NSFilePromiseReceiver {
    let data: Data
    let completes: Bool
    init(data: Data, completes: Bool = true) { self.data = data; self.completes = completes; super.init() }
    required init?(pasteboardPropertyList propertyList: Any, ofType type: NSPasteboard.PasteboardType) { nil }

    override func receivePromisedFiles(atDestination destinationDir: URL, options: [AnyHashable: Any] = [:], operationQueue: OperationQueue, reader: @escaping (URL, (any Error)?) -> Void) {
        guard completes else { return }
        let permissions = try? FileManager.default.attributesOfItem(atPath: destinationDir.path)[.posixPermissions] as? NSNumber
        precondition(permissions?.intValue == 0o700)
        let url = destinationDir.appendingPathComponent("Promised Screenshot.png")
        do {
            try data.write(to: url)
            reader(url, nil)
        } catch { reader(url, error) }
    }
}

@main
struct HelperTests {
    @MainActor
    static func main() throws {
        func fixture(width: Int, height: Int, dpi: Double) throws -> Data {
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(NSColor.red.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            return try Screenshot.encoded(context.makeImage()!, type: .png, displayWidth: Double(width) * 96 / dpi)
        }
        let cases: [(Int, Int, Double, Int, Int, Double)] = [
            (2400, 1500, 144, 1280, 800, 640),
            (1800, 900, 72, 1280, 640, 640),
            (600, 400, 144, 600, 400, 300),
            (320, 200, 72, 320, 200, 320),
        ]
        for (width, height, dpi, expectedWidth, expectedHeight, displayWidth) in cases {
            let image = try Screenshot.fitted(fixture(width: width, height: height, dpi: dpi))
            precondition(image.pixelWidth == expectedWidth && image.pixelHeight == expectedHeight)
            precondition(abs(image.displayWidth - displayWidth) < 0.1)
            precondition(image.displayWidth <= Double(width) && image.pixelWidth <= width)
            let representations = try image.representations()
            let tiff = NSBitmapImageRep(data: representations.tiff)!
            precondition(abs(tiff.size.width - displayWidth * 0.75) < 0.1)
            precondition(tiff.pixelsWide == expectedWidth && tiff.pixelsHigh == expectedHeight)
        }
        let image = try Screenshot.fitted(fixture(width: 2400, height: 1500, dpi: 144))
        let delivery = ScreenshotDelivery(bundleId: "test", before: "See <error> & details.\n\n", after: "\n\nSteps follow.", image: image)
        let item = try delivery.pasteboardItem()
        let html = item.string(forType: .html)!
        precondition(html.contains("See &lt;error&gt; &amp; details."))
        precondition(html.contains("width=\"640\" height=\"400\""))
        precondition(html.range(of: "<img")!.lowerBound < html.range(of: "Steps follow.")!.lowerBound)
        let rich = try NSAttributedString(data: item.data(forType: .rtfd)!, options: [.documentType: NSAttributedString.DocumentType.rtfd], documentAttributes: nil)
        precondition(rich.string == "See <error> & details.\n\n\u{fffc}\n\nSteps follow.")
        let attachment = rich.attribute(.attachment, at: "See <error> & details.\n\n".utf16.count, effectiveRange: nil) as! NSTextAttachment
        let bitmap = NSBitmapImageRep(data: attachment.fileWrapper!.regularFileContents!)!
        precondition(bitmap.pixelsWide == 1280 && abs(bitmap.size.width - 480) < 0.1)
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let original = NSPasteboardItem()
        original.setString("Original clipboard", forType: .string)
        original.setData(Data([1, 2, 3]), forType: NSPasteboard.PasteboardType("test.private"))
        pasteboard.writeObjects([original])
        let snapshot = PasteboardSnapshot(pasteboard)
        pasteboard.clearContents()
        pasteboard.writeObjects([item])
        snapshot.restore(to: pasteboard, ifUnchanged: pasteboard.changeCount)
        precondition(pasteboard.string(forType: .string) == "Original clipboard")
        precondition(pasteboard.data(forType: NSPasteboard.PasteboardType("test.private")) == Data([1, 2, 3]))
        let oldCount = pasteboard.changeCount
        pasteboard.clearContents()
        pasteboard.setString("New user copy", forType: .string)
        snapshot.restore(to: pasteboard, ifUnchanged: oldCount)
        precondition(pasteboard.string(forType: .string) == "New user copy")
        let fixtureDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: fixtureDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: fixtureDirectory) }
        let imageFile = fixtureDirectory.appendingPathComponent("CleanShot 2026-10-20 at 6.05.26 PM@2x.png")
        try fixture(width: 600, height: 400, dpi: 144).write(to: imageFile)
        pasteboard.clearContents()
        pasteboard.writeObjects([imageFile as NSURL])
        guard try Screenshot.read(from: pasteboard) != nil else {
            FileHandle.standardError.write(Data("FAIL: file-only clipboard screenshot was not attached\n".utf8))
            exit(1)
        }
        let finderItem = NSPasteboardItem()
        finderItem.setString(imageFile.absoluteString, forType: .fileURL)
        let icon = try Screenshot.fitted(fixture(width: 16, height: 16, dpi: 72)).representations()
        finderItem.setData(icon.tiff, forType: .tiff)
        pasteboard.clearContents()
        pasteboard.writeObjects([finderItem])
        precondition((try? Screenshot.read(from: pasteboard))?.pixelWidth == 600, "Read the screenshot, not Finder's icon")
        for value in [imageFile.path, imageFile.absoluteString, "\"" + imageFile.path + "\""] {
            pasteboard.clearContents()
            pasteboard.setString(value, forType: .string)
            precondition((try? Screenshot.read(from: pasteboard))?.pixelWidth == 600)
        }
        pasteboard.clearContents()
        pasteboard.setPropertyList([imageFile.path], forType: NSPasteboard.PasteboardType("NSFilenamesPboardType"))
        precondition((try? Screenshot.read(from: pasteboard))?.pixelWidth == 600)
        pasteboard.clearContents()
        pasteboard.setData(try Data(contentsOf: imageFile), forType: .png)
        precondition((try? Screenshot.read(from: pasteboard))?.pixelWidth == 600)
        pasteboard.clearContents()
        pasteboard.setData(icon.tiff, forType: .tiff)
        precondition((try? Screenshot.read(from: pasteboard)) != nil)
        precondition((try? Screenshot.readFile(fixtureDirectory.path)) == nil)
        let textFile = fixtureDirectory.appendingPathComponent("Not an image.png")
        try Data("hello".utf8).write(to: textFile)
        precondition((try? Screenshot.readFile(textFile.path)) == nil)
        precondition((try? Screenshot.readFile("https://example.com/image.png")) == nil)
        let preview = NSBitmapImageRep(data: Data(base64Encoded: image.previewPNG!)!)!
        precondition(preview.pixelsWide <= 640 && preview.pixelsHigh <= 400)
        let promisesBefore = try FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)
        let promised = try Screenshot.receivePromises([PromiseFixture(data: Data(contentsOf: imageFile))])
        precondition(promised?.pixelWidth == 600, "Promised screenshots must be materialized")
        let unfinished = try Screenshot.receivePromises([PromiseFixture(data: Data(), completes: false)])
        precondition(unfinished == nil)
        let promisesAfter = try FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)
        precondition(Set(promisesBefore) == Set(promisesAfter), "Promised files must be removed")
        do {
            _ = try Screenshot.fitted(Data("not an image".utf8))
            preconditionFailure("Invalid images must fail")
        } catch ScreenshotError.invalidImage {}
        print("Helper tests passed: bitmap/file/path/promise capture, thumbnail sizing, inline delivery, clipboard restoration")
    }
}
