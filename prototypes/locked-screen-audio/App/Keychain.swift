import Foundation
import Security

/// Stores the OpenAI key on this device only. AfterFirstUnlock so reconnects work while the phone is locked.
enum Keychain {
    private static let service = "co.joombo.t3voice.proto"
    private static let account = "openai-api-key"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    @discardableResult
    static func save(_ value: String) -> Bool {
        delete()
        var query = baseQuery
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData as String] = Data(value.utf8)
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete() -> Bool {
        SecItemDelete(baseQuery as CFDictionary) == errSecSuccess
    }
}
