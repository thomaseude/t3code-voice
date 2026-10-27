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
    private var session: OpenedSession { OpenedSession(id: "s1", answer: "v=0 answer", connection: paired) }

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
        XCTAssertEqual(store.connection?.replacedToken, "device-token-1")
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

    // MARK: Voice sessions

    func testOpeningASessionSendsTheOfferAndTheTimeZoneAndReadsTheAnswer() async throws {
        let transport = FakeTransport()
        transport.responses = [response(201, json: #"{"sessionId":"s1","sdp":"v=0 answer"}"#)]
        let client = CompanionClient(transport: transport, store: InMemoryConnectionStore(paired))

        let session = try await client.openSession(offer: "v=0 offer", timeZone: "Europe/Paris")

        XCTAssertEqual(session, OpenedSession(id: "s1", answer: "v=0 answer", connection: paired))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/sessions"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(transport.jsonBody(of: request), ["sdp": "v=0 offer", "timeZone": "Europe/Paris"])
    }

    func testOpeningASessionStoresANewTokenFromTheCompanionAndClosesWithIt() async throws {
        // Once the new token is used, the old one stops working.
        let transport = FakeTransport()
        transport.responses = [
            response(201, json: #"{"sessionId":"s1","sdp":"v=0"}"#, headers: ["t3voice-token": "device-token-2"]),
            response(204),
        ]
        let store = InMemoryConnectionStore(paired)
        let client = CompanionClient(transport: transport, store: store)

        let opened = try await client.openSession(offer: "v=0", timeZone: "Europe/Paris")
        try await client.closeSession(opened)

        XCTAssertEqual(store.connection?.token, "device-token-2")
        XCTAssertEqual(transport.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-2")
    }

    func testClosingASessionAfterAnotherRequestGotANewTokenUsesTheNewToken() async throws {
        // GET /activity received the new token while the session was open with the old one.
        let transport = FakeTransport()
        transport.responses = [response(204)]
        var rotated = paired
        rotated.token = "device-token-2"
        rotated.replacedToken = "device-token-1"

        try await CompanionClient(transport: transport, store: InMemoryConnectionStore(rotated)).closeSession(session)

        XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-2")
    }

    func testWithoutAnOpenAIKeyOnTheCompanionVoiceIsUnavailable() async {
        let transport = FakeTransport()
        transport.responses = [response(503, json: #"{"error":"voice_unavailable"}"#)]

        await assertThrows(CompanionError.voiceUnavailable) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired))
                .openSession(offer: "v=0", timeZone: "Europe/Paris")
        }
    }

    func testWhenOpenAIRefusesTheVoiceEngineFailed() async {
        let transport = FakeTransport()
        transport.responses = [response(502, json: #"{"error":"voice_engine_failed"}"#)]

        await assertThrows(CompanionError.voiceEngineFailed) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired))
                .openSession(offer: "v=0", timeZone: "Europe/Paris")
        }
    }

    func testARevokedDeviceCannotOpenASession() async {
        let transport = FakeTransport()
        transport.responses = [response(401)]

        await assertThrows(CompanionError.unauthorized) {
            _ = try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired))
                .openSession(offer: "v=0", timeZone: "Europe/Paris")
        }
    }

    func testClosingASessionSendsADeleteWithTheToken() async throws {
        let transport = FakeTransport()
        transport.responses = [response(204)]

        try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired)).closeSession(session)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/sessions/s1"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
    }

    func testClosingASessionTheCompanionNoLongerHasIsNotAnError() async throws {
        // The voice model may have ended it already ("fin"), or a newer session replaced it.
        let transport = FakeTransport()
        transport.responses = [response(404, json: #"{"error":"not_found"}"#)]

        try await CompanionClient(transport: transport, store: InMemoryConnectionStore(paired)).closeSession(session)
    }

    func testClosingASessionAfterTheConnectionWasForgottenUsesTheConnectionThatOpenedIt() async throws {
        // "Oublier" while the companion opens the session deletes the token before the close.
        let transport = FakeTransport()
        transport.responses = [response(204)]

        try await CompanionClient(transport: transport, store: InMemoryConnectionStore()).closeSession(session)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/sessions/s1"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
    }

    func testClosingASessionAfterPairingAgainUsesTheDeviceThatOpenedIt() async throws {
        // Pairing again with the same companion creates a new device, and the companion
        // closes a session only for the device that opened it.
        let transport = FakeTransport()
        transport.responses = [response(204)]
        var newDevice = paired
        newDevice.token = "new-device-token"

        try await CompanionClient(transport: transport, store: InMemoryConnectionStore(newDevice)).closeSession(session)

        XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
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
