import Foundation
import Security

/// How the app reaches its companion: an address and this device's token. A future cloud
/// login can give the same two things. The token is a secret: never log or show it.
struct CompanionConnection: Codable, Equatable {
    var companionURL: URL
    var token: String
}

/// Where the connection is kept between launches.
protocol ConnectionStore {
    func load() throws -> CompanionConnection?
    func save(_ connection: CompanionConnection) throws
    func delete() throws
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// Keeps the connection in the Keychain, on this device only (no iCloud sync, no backup).
/// It stays readable after the first unlock, so a locked phone can still reach the companion.
struct KeychainConnectionStore: ConnectionStore {
    let service: String
    private let account = "companion-connection"

    init(service: String = "co.joombo.t3voice") {
        self.service = service
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() throws -> CompanionConnection? {
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode(CompanionConnection.self, from: data)
    }

    /// Updates the stored item in place: if the write fails, the old connection is still there.
    func save(_ connection: CompanionConnection) throws {
        let changes: [String: Any] = [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: try JSONEncoder().encode(connection),
        ]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(changes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    /// The protection class of the stored item, for tests.
    func accessibility() -> String? {
        var search = query
        search[kSecReturnAttributes as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess,
              let attributes = item as? [String: Any]
        else { return nil }
        return attributes[kSecAttrAccessible as String] as? String
    }
}
