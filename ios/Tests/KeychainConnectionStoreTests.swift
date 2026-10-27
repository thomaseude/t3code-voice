// The real Keychain, in the simulator, under a service name of its own.

import Security
import XCTest
@testable import T3Voice

final class KeychainConnectionStoreTests: XCTestCase {
    private let store = KeychainConnectionStore(service: "co.joombo.t3voice.tests")
    private let connection = CompanionConnection(
        companionURL: URL(string: "https://voice.example.com")!,
        token: "device-token-1"
    )

    override func setUp() async throws {
        try store.delete()
    }

    override func tearDown() async throws {
        try store.delete()
    }

    func testNoConnectionBeforePairing() throws {
        XCTAssertNil(try store.load())
    }

    func testSavesReadsBackAndReplacesTheConnection() throws {
        try store.save(connection)
        XCTAssertEqual(try store.load(), connection)

        var rotated = connection
        rotated.token = "device-token-2"
        try store.save(rotated)
        XCTAssertEqual(try store.load(), rotated)
    }

    func testTheTokenStaysOnThisDeviceAndIsReadableWhileLocked() throws {
        // Not synced, not in backups, and readable after the first unlock (a locked phone reconnects).
        try store.save(connection)

        XCTAssertEqual(store.accessibility(), kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testForgettingDeletesTheConnection() throws {
        try store.save(connection)
        try store.delete()

        XCTAssertNil(try store.load())
    }
}
