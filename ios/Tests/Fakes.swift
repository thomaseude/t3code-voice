// In-memory stand-ins for the network and the Keychain, to test the app's logic without them.

import Foundation
@testable import T3Voice

/// Answers each request with the next queued response, and records what was sent.
final class FakeTransport: HTTPTransport {
    private(set) var requests: [URLRequest] = []
    var responses: [HTTPResponse] = []
    /// Runs while a request waits for its answer, like the user acting during a slow network.
    var whileWaiting: (() async -> Void)?

    func send(_ request: URLRequest) async throws -> HTTPResponse {
        requests.append(request)
        await whileWaiting?()
        guard !responses.isEmpty else { throw URLError(.cannotConnectToHost) }
        return responses.removeFirst()
    }

    /// The JSON body of a request, decoded as a dictionary.
    func jsonBody(of request: URLRequest) -> [String: String]? {
        guard let data = request.httpBody else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: data)
    }
}

final class InMemoryConnectionStore: ConnectionStore {
    var connection: CompanionConnection?

    init(_ connection: CompanionConnection? = nil) {
        self.connection = connection
    }

    func load() throws -> CompanionConnection? { connection }
    func save(_ connection: CompanionConnection) throws { self.connection = connection }
    func delete() throws { connection = nil }
}

func response(_ status: Int, json: String = "", headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, headers: headers, body: Data(json.utf8))
}

/// Face ID that answers what the test says.
final class FakeAuthenticator: Authenticator {
    var allows = true
    private(set) var askCount = 0

    func authenticate() async -> Bool {
        askCount += 1
        return allows
    }
}

/// A WebRTC call without WebRTC: it gives a fixed offer and lets the test send its events.
@MainActor
final class FakeVoiceCall: VoiceCall {
    var offer = "v=0 offer"
    var startError: Error?
    var acceptError: Error?
    private(set) var started = false
    private(set) var acceptedAnswer: String?
    private(set) var hungUp = false
    private var onEvent: (@MainActor (VoiceCallEvent) async -> Void)?

    func start(onEvent: @escaping @MainActor (VoiceCallEvent) async -> Void) async throws -> String {
        started = true
        self.onEvent = onEvent
        if let startError { throw startError }
        return offer
    }

    func accept(answer: String) async throws {
        if let acceptError { throw acceptError }
        acceptedAnswer = answer
    }

    func hangUp() {
        hungUp = true
    }

    /// What the data channel or the peer connection reports.
    func emit(_ event: VoiceCallEvent) async {
        await onEvent?(event)
    }
}

/// Records every state the user was shown (Live Activity, start sound, screen).
@MainActor
final class FakeFeedback: SessionFeedback {
    private(set) var shown: [SessionState] = []

    func show(_ state: SessionState) {
        shown.append(state)
    }
}
