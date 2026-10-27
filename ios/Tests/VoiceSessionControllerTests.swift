// A voice conversation from "Parler" to its end, through the session controller with a fake
// Face ID, a fake WebRTC call and a fake network: the states the user sees, what is sent to
// the companion, and when the microphone is closed.

import XCTest
@testable import T3Voice

@MainActor
final class VoiceSessionControllerTests: XCTestCase {
    private let paired = CompanionConnection(
        companionURL: URL(string: "https://voice.example.com")!,
        token: "device-token-1"
    )
    private let opened = response(201, json: #"{"sessionId":"s1","sdp":"v=0 answer"}"#)

    private var transport: FakeTransport!
    private var authenticator: FakeAuthenticator!
    private var calls: [FakeVoiceCall] = []
    private var feedback: FakeFeedback!
    private var controller: VoiceSessionController!

    override func setUp() async throws {
        transport = FakeTransport()
        authenticator = FakeAuthenticator()
        calls = []
        feedback = FakeFeedback()
        controller = makeController()
    }

    private var call: FakeVoiceCall { calls[0] }

    private func startLiveSession() async {
        transport.responses = [opened, response(204)]
        await controller.start()
        await call.emit(.sessionStarted)
    }

    // MARK: Starting

    func testAfterFaceIDTheOfferGoesToTheCompanionAndTheSessionIsLiveOnceItStarted() async throws {
        transport.responses = [opened]

        await controller.start()

        XCTAssertEqual(controller.state, .connecting)
        XCTAssertEqual(call.acceptedAnswer, "v=0 answer")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, URL(string: "https://voice.example.com/sessions"))
        XCTAssertEqual(transport.jsonBody(of: request), ["sdp": "v=0 offer", "timeZone": "Europe/Paris"])

        await call.emit(.sessionStarted)

        XCTAssertEqual(controller.state, .live)
        XCTAssertEqual(feedback.shown, [.authenticating, .connecting, .live])
    }

    func testWithoutFaceIDNothingStarts() async {
        authenticator.allows = false

        await controller.start()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(calls.isEmpty)
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(feedback.shown, [.authenticating, .idle])
    }

    func testEveryStartAsksForFaceIDAgain() async {
        await startLiveSession()
        await controller.end()
        transport.responses = [opened]

        await controller.start()

        XCTAssertEqual(authenticator.askCount, 2)
    }

    func testStartingAgainDuringASessionDoesNothing() async {
        await startLiveSession()

        await controller.start()

        XCTAssertEqual(authenticator.askCount, 1)
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(controller.state, .live)
    }

    func testARefusedMicrophoneSendsNothingAndSaysWhy() async {
        controller = makeController(callStartError: VoiceCallError.microphoneDenied)

        await controller.start()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(controller.lastFailure, .microphoneDenied)
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertTrue(call.hungUp)
    }

    func testACompanionWithoutVoiceEndsTheAttemptAndSaysWhy() async {
        transport.responses = [response(503, json: #"{"error":"voice_unavailable"}"#)]

        await controller.start()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(controller.lastFailure, .voiceUnavailable)
        XCTAssertTrue(call.hungUp)
        XCTAssertEqual(feedback.shown, [.authenticating, .connecting, .ending(.failed(.voiceUnavailable)), .idle])
    }

    func testAnAnswerTheCallCannotApplyClosesTheSessionOnTheCompanion() async throws {
        controller = makeController(acceptError: VoiceCallError.failed)
        transport.responses = [opened, response(204)]

        await controller.start()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(controller.lastFailure, .callFailed)
        let delete = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(delete.httpMethod, "DELETE")
        XCTAssertEqual(delete.url, URL(string: "https://voice.example.com/sessions/s1"))
    }

    func testANewStartForgetsThePreviousFailure() async {
        transport.responses = [response(503, json: #"{"error":"voice_unavailable"}"#)]
        await controller.start()
        transport.responses = [opened]

        await controller.start()

        XCTAssertNil(controller.lastFailure)
    }

    // MARK: Ending

    func testTheEndButtonClosesTheMicrophoneAndTheSessionOnTheCompanion() async throws {
        await startLiveSession()

        await controller.end()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(call.hungUp)
        let delete = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(delete.httpMethod, "DELETE")
        XCTAssertEqual(delete.url, URL(string: "https://voice.example.com/sessions/s1"))
        XCTAssertEqual(delete.value(forHTTPHeaderField: "Authorization"), "Bearer device-token-1")
        XCTAssertEqual(feedback.shown.suffix(2), [.ending(.user), .idle])
    }

    func testSayingFinEndsTheSessionWithoutAskingTheCompanionAgain() async {
        // "fin" or "c'est bon, merci": the voice model calls end_session and the companion
        // closes the session itself.
        await startLiveSession()

        await call.emit(.sessionClosed)

        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(call.hungUp)
        XCTAssertEqual(transport.requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(feedback.shown.suffix(2), [.ending(.voice), .idle])
    }

    func testALostCallEndsTheSessionAndClosesItOnTheCompanion() async {
        await startLiveSession()

        await call.emit(.lost)

        XCTAssertEqual(controller.state, .idle)
        XCTAssertEqual(controller.lastFailure, .lost)
        XCTAssertTrue(call.hungUp)
        XCTAssertEqual(transport.requests.map(\.httpMethod), ["POST", "DELETE"])
    }

    func testEndingWhileTheCompanionOpensTheSessionClosesItWhenItsAnswerArrives() async throws {
        // GPT-Live can take 15 s to answer: the user may give up before.
        let transport = transport!, controller = controller!
        transport.responses = [opened, response(204)]
        transport.whileWaiting = { [unowned transport] in
            transport.whileWaiting = nil
            await controller.end()
        }

        await controller.start()

        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(call.hungUp)
        XCTAssertNil(call.acceptedAnswer)
        XCTAssertEqual(transport.requests.map(\.httpMethod), ["POST", "DELETE"])
        XCTAssertEqual(transport.requests.last?.url, URL(string: "https://voice.example.com/sessions/s1"))
        XCTAssertFalse(feedback.shown.contains(.live))
    }

    func testEventsFromAnEndedCallAreIgnored() async {
        await startLiveSession()
        await controller.end()
        let oldCall = call
        transport.responses = [opened]
        await controller.start()

        await oldCall.emit(.sessionClosed)

        XCTAssertEqual(controller.state, .connecting)
        XCTAssertFalse(calls[1].hungUp)
    }

    // MARK: Helpers

    private func makeController(callStartError: Error? = nil, acceptError: Error? = nil) -> VoiceSessionController {
        VoiceSessionController(
            client: CompanionClient(transport: transport, store: InMemoryConnectionStore(paired)),
            authenticator: authenticator,
            makeCall: { [unowned self] in
                let call = FakeVoiceCall()
                call.startError = callStartError
                call.acceptError = acceptError
                calls.append(call)
                return call
            },
            feedback: feedback,
            timeZone: "Europe/Paris"
        )
    }
}
