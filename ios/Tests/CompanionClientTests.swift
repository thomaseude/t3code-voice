// The app's calls to the companion, through a fake network and a fake Keychain: what is sent,
// what is stored, and what each answer of the companion gives.

import XCTest
@testable import T3Voice

final class CompanionClientTests: XCTestCase {
    private let qrCode = PairingQRCode("t3voice://pair?url=https%3A%2F%2Fvoice.example.com&code=one-time-code")!
    private let paired = CompanionConnection(
        companionURL: URL(string: "https://voice.example.com")!,
        token: "device-token-1"
    )

    // MARK: Pairing

    func testPairingSendsTheCodeAndStoresTheConnection() async throws {
        let transport = FakeTransport()
        transport.responses = [response(200, json: #"{"token":"device-token-1","device":{"id":"d1","name":"iPhone"}}"#)]
        let store = InMemoryConnectionStore()
        let client = CompanionClient(transport: transport, store: store)

        let result = try await client.pair(with: qrCode, deviceName: "iPhone de Thomas")

        XCTAssertEqual(result, .paired(paired))
        XCTAssertEqual(store.connection, paired)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/pair"))
        XCTAssertEqual(transport.jsonBody(of: request), ["code": "one-time-code", "name": "iPhone de Thomas"])
    }

    func testAWrongUsedOrExpiredCodeIsRefusedAndNothingIsStored() async throws {
        let transport = FakeTransport()
        transport.responses = [response(401)]
        let store = InMemoryConnectionStore()

        let result = try await CompanionClient(transport: transport, store: store)
            .pair(with: qrCode, deviceName: "iPhone")

        XCTAssertEqual(result, .refused)
        XCTAssertNil(store.connection)
    }

    func testTooManyWrongCodesSaysWhenToRetry() async throws {
        let transport = FakeTransport()
        transport.responses = [response(429, headers: ["retry-after": "420"])]

        let result = try await CompanionClient(transport: transport, store: InMemoryConnectionStore())
            .pair(with: qrCode, deviceName: "iPhone")

        XCTAssertEqual(result, .limited(retryAfterSeconds: 420))
    }

    // MARK: Activity

    func testActivitySendsTheDeviceTokenAndReadsBothLists() async throws {
        let transport = FakeTransport()
        transport.responses = [response(200, json: """
        {"running":[{"threadId":"t1","title":"Fix the Reviews tests","project":"Joombo","state":"running","updatedAt":"2026-10-26T10:00:00.000Z"}],
         "finished":[{"threadId":"t2","title":"Add dark mode","project":null,"state":"failed","updatedAt":"2026-10-26T09:00:00.000Z"}]}
        """)]
        let client = CompanionClient(transport: transport, store: InMemoryConnectionStore(paired))

        let activity = try await client.activity()

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/activity"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
        XCTAssertEqual(activity.running.map(\.title), ["Fix the Reviews tests"])
        XCTAssertEqual(activity.running.first?.project, "Joombo")
        XCTAssertEqual(activity.finished.first?.state, "failed")
        XCTAssertNil(activity.finished.first?.project)
    }

    func testANewTokenFromTheCompanionReplacesTheStoredOne() async throws {
        // The companion replaces a token on use once it is 30 days old.
        let transport = FakeTransport()
        transport.responses = [response(200, json: #"{"running":[],"finished":[]}"#, headers: ["t3voice-token": "device-token-2"])]
        let store = InMemoryConnectionStore(paired)

        _ = try await CompanionClient(transport: transport, store: store).activity()

        XCTAssertEqual(store.connection?.token, "device-token-2")
        XCTAssertEqual(store.connection?.companionURL, paired.companionURL)
    }

    func testANewTokenIsNotStoredIfTheConnectionWasForgottenMeanwhile() async throws {
        let transport = FakeTransport()
        let store = InMemoryConnectionStore(paired)
        transport.responses = [response(200, json: #"{"running":[],"finished":[]}"#, headers: ["t3voice-token": "device-token-2"])]
        transport.whileWaiting = { store.connection = nil }

        _ = try await CompanionClient(transport: transport, store: store).activity()

        XCTAssertNil(store.connection)
    }

    func testARevokedDeviceIsToldItIsNoLongerPaired() async {
        let transport = FakeTransport()
        transport.responses = [response(401)]

        await assertThrows(CompanionError.unauthorized) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired)).activity()
        }
    }

    func testWhileTheCompanionReconnectsToT3TheActivityIsUnavailable() async {
        let transport = FakeTransport()
        transport.responses = [response(503, json: #"{"error":"t3_unavailable"}"#)]

        await assertThrows(CompanionError.t3Unavailable) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired)).activity()
        }
    }

    func testWithoutAConnectionNothingIsSent() async {
        let transport = FakeTransport()

        await assertThrows(CompanionError.notPaired) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore()).activity()
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    private func assertThrows(
        _ expected: CompanionError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? CompanionError, expected, file: file, line: line)
        }
    }
}
