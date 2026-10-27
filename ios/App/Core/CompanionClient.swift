import Foundation

/// An HTTP answer, with header names in lower case.
struct HTTPResponse {
    let status: Int
    let headers: [String: String]
    let body: Data
}

/// Sends one HTTP request. The real one is URLSession; tests use a fake.
protocol HTTPTransport {
    func send(_ request: URLRequest) async throws -> HTTPResponse
}

struct URLSessionTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value }
        }
        return HTTPResponse(status: http.statusCode, headers: headers, body: data)
    }
}

enum PairingResult: Equatable {
    case paired(CompanionConnection)
    /// A wrong, used or expired code, or no pairing window open: the companion says no more.
    case refused
    /// Too many wrong codes lately, for every caller: retry after this many seconds.
    case limited(retryAfterSeconds: Int?)
}

enum CompanionError: Error, Equatable {
    /// No connection is stored: the app must pair first.
    case notPaired
    /// The companion refused the token: the device was revoked, or the companion was reset.
    case unauthorized
    /// The companion is reconnecting to T3 and has no fresh state to give.
    case t3Unavailable
    case limited(retryAfterSeconds: Int?)
    case unexpected(status: Int)
}

/// The companion's HTTP API, as the app calls it (`companion/README.md`, "Routes").
struct CompanionClient {
    let transport: HTTPTransport
    let store: ConnectionStore

    func pair(with qrCode: PairingQRCode, deviceName: String) async throws -> PairingResult {
        var request = URLRequest(url: qrCode.companionURL.appending(path: "pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": qrCode.code, "name": deviceName])
        let response = try await transport.send(request)
        switch response.status {
        case 200:
            let answer = try JSONDecoder().decode(PairAnswer.self, from: response.body)
            let connection = CompanionConnection(companionURL: qrCode.companionURL, token: answer.token)
            try store.save(connection)
            return .paired(connection)
        case 401:
            return .refused
        case 429:
            return .limited(retryAfterSeconds: retryAfter(response))
        default:
            throw CompanionError.unexpected(status: response.status)
        }
    }

    func activity() async throws -> Activity {
        guard let connection = try store.load() else { throw CompanionError.notPaired }
        var request = URLRequest(url: connection.companionURL.appending(path: "activity"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        let response = try await transport.send(request)
        // A token 30 days old is replaced on use: the old one works until the new one is used.
        // A connection forgotten or replaced while the request was out is left as it is.
        if let replacement = response.headers["t3voice-token"], !replacement.isEmpty,
           try store.load() == connection {
            var rotated = connection
            rotated.token = replacement
            try store.save(rotated)
        }
        switch response.status {
        case 200:
            return try JSONDecoder().decode(Activity.self, from: response.body)
        case 401:
            throw CompanionError.unauthorized
        case 429:
            throw CompanionError.limited(retryAfterSeconds: retryAfter(response))
        case 503:
            throw CompanionError.t3Unavailable
        default:
            throw CompanionError.unexpected(status: response.status)
        }
    }

    private func retryAfter(_ response: HTTPResponse) -> Int? {
        response.headers["retry-after"].flatMap { Int($0) }
    }
}

private struct PairAnswer: Decodable {
    let token: String
}

/// What T3 runs now and what finished in the last 24 hours (`GET /activity`).
struct Activity: Decodable, Equatable {
    let running: [ActivityItem]
    let finished: [ActivityItem]
}

struct ActivityItem: Decodable, Equatable, Identifiable {
    let threadId: String
    let title: String
    /// Nil when T3 did not send the project.
    let project: String?
    /// T3's state name: see `label(for:)`.
    let state: String
    /// ISO date of the thread's last change.
    let updatedAt: String

    var id: String { threadId }

    /// T3's state names, in French. A state from a newer T3 is shown as is.
    static func label(for state: String) -> String {
        switch state {
        case "running": "en cours"
        case "waiting_for_input": "attend ta réponse"
        case "waiting_for_approval": "demande une autorisation"
        case "completed": "terminée"
        case "failed": "échouée"
        default: state
        }
    }
}
