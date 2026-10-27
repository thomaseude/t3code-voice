// What the screens show, through the app model with a fake network and a fake Keychain.

import XCTest
@testable import T3Voice

@MainActor
final class AppModelTests: XCTestCase {
    private let qrCode = "t3voice://pair?url=https%3A%2F%2Fvoice.example.com&code=one-time-code"
    private let paired = CompanionConnection(
        companionURL: URL(string: "https://voice.example.com")!,
        token: "device-token-1"
    )

    // MARK: Pairing

    func testScanningAValidCodePairsWithTheNameTheUserTyped() async {
        let transport = FakeTransport()
        transport.responses = [response(200, json: #"{"token":"device-token-1","device":{"id":"d1","name":"iPhone de Thomas"}}"#)]
        let model = AppModel(store: InMemoryConnectionStore(), transport: transport, deviceName: "iPhone")
        model.deviceName = "  iPhone de Thomas "

        await model.scanned(qrCode)

        XCTAssertTrue(model.isPaired)
        XCTAssertEqual(model.pairingStatus, .scanning)
        XCTAssertEqual(transport.jsonBody(of: transport.requests[0])?["name"], "iPhone de Thomas")
    }

    func testAnEmptyNameFallsBackToTheModelName() async {
        let transport = FakeTransport()
        transport.responses = [response(200, json: #"{"token":"t","device":{"id":"d1","name":"iPhone"}}"#)]
        let model = AppModel(store: InMemoryConnectionStore(), transport: transport, deviceName: "iPhone")
        model.deviceName = "   "

        await model.scanned(qrCode)

        XCTAssertEqual(transport.jsonBody(of: transport.requests[0])?["name"], "iPhone")
    }

    func testAnotherQRCodeSendsNothingAndSaysWhy() async {
        let transport = FakeTransport()
        let model = AppModel(store: InMemoryConnectionStore(), transport: transport, deviceName: "iPhone")

        await model.scanned("https://example.com")

        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(model.pairingStatus, .failed("Ce QR code n'est pas un code d'appairage T3 Voice."))
    }

    func testARefusedCodeAsksToRunPairAgain() async {
        let transport = FakeTransport()
        transport.responses = [response(401)]
        let model = AppModel(store: InMemoryConnectionStore(), transport: transport, deviceName: "iPhone")

        await model.scanned(qrCode)

        XCTAssertFalse(model.isPaired)
        XCTAssertEqual(model.pairingStatus, .failed("Code refusé : il a déjà servi ou a expiré. Relance « t3-voice pair »."))
    }

    func testTooManyCodesGivesTheWaitInWholeMinutes() async {
        let transport = FakeTransport()
        transport.responses = [response(429, headers: ["retry-after": "421"]), response(429)]
        let model = AppModel(store: InMemoryConnectionStore(), transport: transport, deviceName: "iPhone")

        await model.scanned(qrCode)
        XCTAssertEqual(model.pairingStatus, .failed("Trop d'essais. Réessaie dans 8 minutes."))

        model.retryScanning()
        await model.scanned(qrCode)
        XCTAssertEqual(model.pairingStatus, .failed("Trop d'essais. Réessaie dans quelques minutes."))
    }

    func testRetryingRestartsTheScanner() {
        let model = AppModel(store: InMemoryConnectionStore(), transport: FakeTransport(), deviceName: "iPhone")
        let before = model.scanAttempt

        model.retryScanning()

        XCTAssertNotEqual(model.scanAttempt, before)
    }

    // MARK: Activity

    func testARevokedDeviceGoesBackToPairing() async {
        let transport = FakeTransport()
        transport.responses = [response(401)]
        let store = InMemoryConnectionStore(paired)
        let model = AppModel(store: store, transport: transport, deviceName: "iPhone")

        await model.refreshActivity()

        XCTAssertFalse(model.isPaired)
        XCTAssertNil(store.connection)
    }

    func testALostConnectionGoesBackToPairing() async {
        // For example, the Keychain lost the item: nothing can reach the companion any more.
        let store = InMemoryConnectionStore(paired)
        let model = AppModel(store: store, transport: FakeTransport(), deviceName: "iPhone")
        store.connection = nil

        await model.refreshActivity()

        XCTAssertFalse(model.isPaired)
    }

    func testForgettingDuringARefreshKeepsTheAppUnpaired() async {
        let transport = FakeTransport()
        let store = InMemoryConnectionStore(paired)
        let model = AppModel(store: store, transport: transport, deviceName: "iPhone")
        transport.responses = [response(200, json: #"{"running":[],"finished":[]}"#)]
        transport.whileWaiting = { await model.forget() }

        await model.refreshActivity()

        XCTAssertFalse(model.isPaired)
        XCTAssertEqual(model.activityStatus, .loading)
    }

    func testWhileT3ReconnectsTheActivitySaysSo() async {
        let transport = FakeTransport()
        transport.responses = [response(503, json: #"{"error":"t3_unavailable"}"#)]
        let model = AppModel(store: InMemoryConnectionStore(paired), transport: transport, deviceName: "iPhone")

        await model.refreshActivity()

        XCTAssertTrue(model.isPaired)
        XCTAssertEqual(model.activityStatus, .failed("Le companion se reconnecte à T3. Réessaie dans un instant."))
    }

    // MARK: State labels

    func testStatesAreShownInFrenchAndAnUnknownOneAsIs() {
        XCTAssertEqual(ActivityItem.label(for: "waiting_for_approval"), "demande une autorisation")
        XCTAssertEqual(ActivityItem.label(for: "completed"), "terminée")
        XCTAssertEqual(ActivityItem.label(for: "paused_by_a_newer_t3"), "paused_by_a_newer_t3")
    }
}
