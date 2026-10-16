import CryptoKit
import Foundation
import Security

/// Seals Composer history with a key kept in Keychain, so the stored file alone reveals nothing.
enum HistorySealing {
    enum Failure: Error {
        case noKey
        case keychain(OSStatus)
        case invalid
    }

    static let service = "tech.uncomplicate.tinycast-composer"
    static let account = "history-key"

    static func seal(_ plaintext: Data, using key: SymmetricKey) throws -> String {
        guard let combined = try AES.GCM.seal(plaintext, using: key).combined else { throw Failure.invalid }
        return combined.base64EncodedString()
    }

    static func open(_ sealed: String, using key: SymmetricKey) throws -> Data {
        guard let combined = Data(base64Encoded: sealed.trimmingCharacters(in: .whitespacesAndNewlines))
        else { throw Failure.invalid }
        do {
            return try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key)
        } catch {
            throw Failure.invalid
        }
    }

    /// A Keychain error yields no key rather than a new one, which would orphan the saved history.
    static func keychainKey(creating: Bool) throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        guard status == errSecItemNotFound else { throw Failure.keychain(status) }
        guard creating else { throw Failure.noKey }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Tinycast Composer history",
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data
        ]
        let added = SecItemAdd(attributes as CFDictionary, nil)
        guard added == errSecSuccess else { throw Failure.keychain(added) }
        return key
    }

    static func describe(_ error: Error) -> String {
        switch error as? Failure {
        case .noKey: "no-key"
        case .keychain(let status): "keychain \(status)"
        case .invalid: "invalid"
        case nil: "\(error)"
        }
    }
}
