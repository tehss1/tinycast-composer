import AppKit
import ImageIO
import UniformTypeIdentifiers

func emit(_ object: [String: Any]) -> Never { fatalError("Not used by tests") }

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
        do {
            _ = try Screenshot.fitted(Data("not an image".utf8))
            preconditionFailure("Invalid images must fail")
        } catch ScreenshotError.invalidImage {}
        print("Helper tests passed: Retina sizing, no upscaling, HTML/RTFD inline order, clipboard restoration")
    }
}
