// Reads the focused Outlook compose window, and seals Composer history, for the extension.
// Runs as a child of Tinycast, so macOS checks Tinycast's Accessibility grant, not this binary's.

import AppKit
import ApplicationServices

let outlookBundleIdentifier = "com.microsoft.Outlook"
let maximumElements = 800
nonisolated(unsafe) let emailAddress = #/[\p{L}\p{N}.!#$%&'*+\/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?/#
let subjectFieldIdentifier = "subjectTextField"
let recipientFieldIdentifiers: Set<String> = ["toTextField", "ccTextField", "bccTextField"]

enum Budget {
    static let total: Duration = .milliseconds(750)
    static let maximumCall: Duration = .milliseconds(100)
    static let readingReserve: Duration = .milliseconds(350)
    static let maximumDiscovery: Duration = .milliseconds(250)

    static func discoveryAllowance(elapsed: Duration) -> Duration {
        max(.zero, min(maximumDiscovery, total - elapsed - readingReserve))
    }

    static func callTimeout(remaining: Duration) -> Float? {
        guard remaining > .zero else { return nil }
        let duration = min(maximumCall, remaining).components
        return Float(Double(duration.seconds) + Double(duration.attoseconds) / 1e18)
    }
}

struct Access {
    var deadline: ContinuousClock.Instant
    var complete = true

    mutating func descendants(
        identifiers: Set<String>, in root: AXUIElement, allowance: Duration
    ) -> [(identifier: String, element: AXUIElement)] {
        let readingDeadline = deadline
        deadline = min(deadline, ContinuousClock.now + allowance)
        defer { deadline = readingDeadline }
        var queue = [root]
        var index = 0
        var matches: [(identifier: String, element: AXUIElement)] = []
        var found: Set<String> = []
        while index < queue.count, !identifiers.isSubset(of: found), withinDeadline() {
            let candidate = queue[index]
            index += 1
            if let identifier = string(candidate, attribute: kAXIdentifierAttribute),
                identifiers.contains(identifier)
            {
                matches.append((identifier, candidate))
                found.insert(identifier)
                continue
            }
            _ = appendChildren(of: candidate, to: &queue)
        }
        return matches
    }

    mutating func subject(in field: AXUIElement) -> String? {
        let value = string(field, attribute: kAXValueAttribute)
        if let value, usable(value) { return value }
        let children = attribute(field, name: kAXChildrenAttribute) as? [AXUIElement] ?? []
        var candidates: [String] = []
        for child in children { candidates += textCandidates(in: child) }
        // A readable but empty field's own title is its label, never a subject.
        if value == nil, let title = string(field, attribute: kAXTitleAttribute), usable(title) {
            candidates.append(title)
        }
        return candidates.max { $0.count < $1.count }
    }

    mutating func textCandidates(in root: AXUIElement) -> [String] {
        var queue = [root]
        var index = 0
        var candidates: [String] = []
        while index < queue.count, withinDeadline() {
            let candidate = queue[index]
            index += 1
            var readable = false
            var texts: [String] = []
            var fieldValue: String?
            for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                if let text = string(candidate, attribute: attribute) {
                    readable = true
                    if usable(text) {
                        texts.append(text)
                        if attribute == kAXValueAttribute { fieldValue = text }
                    }
                }
            }
            let childCount = appendChildren(of: candidate, to: &queue)
            let addresses = texts.filter { $0.firstMatch(of: emailAddress) != nil }
            if !addresses.isEmpty {
                candidates.append(contentsOf: addresses)
            } else if childCount == 0 {
                candidates.append(contentsOf: texts)
                if !readable { complete = false }
            } else if let fieldValue {
                candidates.append(fieldValue)
            }
        }
        return candidates
    }

    private func usable(_ value: String) -> Bool {
        !value.replacingOccurrences(of: "\u{fffc}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private mutating func appendChildren(of element: AXUIElement, to queue: inout [AXUIElement]) -> Int {
        guard let children = attribute(element, name: kAXChildrenAttribute) as? [AXUIElement]
        else { return 0 }
        let remaining = maximumElements - queue.count
        if children.count > remaining { complete = false }
        queue.append(contentsOf: children.prefix(max(remaining, 0)))
        return children.count
    }

    mutating func element(_ root: AXUIElement, attribute name: String) -> AXUIElement? {
        guard let value = attribute(root, name: name),
            CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    mutating func string(_ element: AXUIElement, attribute name: String) -> String? {
        attribute(element, name: name) as? String
    }

    mutating func selectedRange(in element: AXUIElement) -> CFRange? {
        guard let value = attribute(element, name: kAXSelectedTextRangeAttribute),
            CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return range
    }

    private mutating func attribute(_ element: AXUIElement, name: String) -> CFTypeRef? {
        guard withinDeadline() else { return nil }
        guard let timeout = Budget.callTimeout(remaining: deadline - ContinuousClock.now) else {
            complete = false
            return nil
        }
        guard AXUIElementSetMessagingTimeout(element, timeout) == .success else {
            complete = false
            return nil
        }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard status == .success else {
            if status != .attributeUnsupported && status != .noValue { complete = false }
            return nil
        }
        return value
    }

    private mutating func withinDeadline() -> Bool {
        guard ContinuousClock.now < deadline else {
            complete = false
            return false
        }
        return true
    }
}

func emit(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func readOutlook() -> Never {
    guard
        let app = NSRunningApplication.runningApplications(
            withBundleIdentifier: outlookBundleIdentifier
        ).first
    else { emit(["status": "not-running"]) }
    guard AXIsProcessTrusted() else { emit(["status": "not-trusted"]) }

    let started = ContinuousClock.now
    var access = Access(deadline: started + Budget.total)
    let application = AXUIElementCreateApplication(app.processIdentifier)
    guard let editor = access.element(application, attribute: kAXFocusedUIElementAttribute),
        let body = access.string(editor, attribute: kAXValueAttribute),
        let range = access.selectedRange(in: editor),
        range.location >= 0, range.length >= 0, range.location + range.length <= body.utf16.count
    else { emit(["status": "no-editor"]) }

    let window = access.element(application, attribute: kAXFocusedWindowAttribute)
        ?? access.element(application, attribute: kAXMainWindowAttribute)
    var fields: [(identifier: String, element: AXUIElement)] = []
    if let window {
        fields = access.descendants(
            identifiers: recipientFieldIdentifiers.union([subjectFieldIdentifier]), in: window,
            allowance: Budget.discoveryAllowance(elapsed: ContinuousClock.now - started))
    }
    var subject: String?
    if let field = fields.first(where: { $0.identifier == subjectFieldIdentifier }) {
        subject = access.subject(in: field.element)
    }
    let recipientFields = fields.filter { $0.identifier != subjectFieldIdentifier }
    var candidates: [String] = []
    for field in recipientFields { candidates += access.textCandidates(in: field.element) }

    var result: [String: Any] = [
        "status": "ok",
        "body": body,
        "location": range.location,
        "length": range.length,
        "recipientCandidates": candidates,
        "captureComplete": !recipientFields.isEmpty && access.complete
    ]
    if let subject { result["subject"] = subject }
    emit(result)
}

/// stdin in, stdout out, so history never touches an argument list another process can read.
func sealHistory(opening: Bool) -> Never {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    do {
        let key = try HistorySealing.keychainKey(creating: !opening)
        if opening {
            let sealed = String(decoding: input, as: UTF8.self)
            FileHandle.standardOutput.write(try HistorySealing.open(sealed, using: key))
        } else {
            FileHandle.standardOutput.write(Data(try HistorySealing.seal(input, using: key).utf8))
        }
        exit(0)
    } catch {
        FileHandle.standardError.write(Data(HistorySealing.describe(error).utf8))
        exit(3)
    }
}

switch CommandLine.arguments.dropFirst().first {
case "outlook-context": readOutlook()
case "seal": sealHistory(opening: false)
case "open": sealHistory(opening: true)
default:
    FileHandle.standardError.write(Data("usage: composer-helper outlook-context | seal | open\n".utf8))
    exit(2)
}
