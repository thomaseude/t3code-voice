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
