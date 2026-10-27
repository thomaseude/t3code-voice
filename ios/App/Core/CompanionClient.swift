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
    /// The companion has no OpenAI key: voice conversations are off.
    case voiceUnavailable
    /// OpenAI refused the session or could not be reached.
    case voiceEngineFailed
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
        let response = try await sendWithToken(method: "GET", path: "activity", connection: storedConnection())
        switch response.status {
        case 200:
            return try JSONDecoder().decode(Activity.self, from: response.body)
        case 503:
            throw CompanionError.t3Unavailable
        default:
            throw commonError(response)
        }
    }

    /// Starts a voice conversation: the companion sends the offer to the voice engine and
    /// gives back its answer. It can take up to about 18 seconds.
    func openSession(offer: String, timeZone: String) async throws -> OpenedSession {
        let connection = try storedConnection()
        let body = try JSONEncoder().encode(["sdp": offer, "timeZone": timeZone])
        let response = try await sendWithToken(method: "POST", path: "sessions", body: body, connection: connection)
        switch response.status {
        case 201:
            let answer = try JSONDecoder().decode(SessionAnswer.self, from: response.body)
            // The session is closed with the token the companion expects from now on.
            var opener = connection
            if let replacement = response.headers["t3voice-token"], !replacement.isEmpty { opener.token = replacement }
            return OpenedSession(id: answer.sessionId, answer: answer.sdp, connection: opener)
        case 502:
            throw CompanionError.voiceEngineFailed
        case 503:
            throw CompanionError.voiceUnavailable
        default:
            throw commonError(response)
        }
    }

    /// Ends the conversation on the companion. A session it no longer has is already ended.
    /// It uses the connection that opened the session, never the stored one: the companion
    /// closes a session only for the device that opened it, and the stored connection may be
    /// gone ("Oublier") or another device's (paired again).
    func closeSession(_ session: OpenedSession) async throws {
        let response = try await sendWithToken(method: "DELETE", path: "sessions/\(session.id)", connection: session.connection)
        switch response.status {
        case 204, 404:
            return
        default:
            throw commonError(response)
        }
    }

    private func storedConnection() throws -> CompanionConnection {
        guard let connection = try store.load() else { throw CompanionError.notPaired }
        return connection
    }

    /// Sends a request with the device token, and stores the new token the companion may give.
    private func sendWithToken(
        method: String,
        path: String,
        body: Data? = nil,
        connection: CompanionConnection
    ) async throws -> HTTPResponse {
        var request = URLRequest(url: connection.companionURL.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let response = try await transport.send(request)
        // A token 30 days old is replaced on use: the old one works until the new one is used.
        // A connection forgotten or replaced while the request was out is left as it is.
        if let replacement = response.headers["t3voice-token"], !replacement.isEmpty,
           try store.load() == connection {
            var rotated = connection
            rotated.token = replacement
            try store.save(rotated)
        }
        return response
    }

    /// The answers every route with a device token can give.
    private func commonError(_ response: HTTPResponse) -> CompanionError {
        switch response.status {
        case 401: .unauthorized
        case 429: .limited(retryAfterSeconds: retryAfter(response))
        default: .unexpected(status: response.status)
        }
    }

    private func retryAfter(_ response: HTTPResponse) -> Int? {
        response.headers["retry-after"].flatMap { Int($0) }
    }
}

private struct PairAnswer: Decodable {
    let token: String
}

private struct SessionAnswer: Decodable {
    let sessionId: String
    let sdp: String
}

/// A voice conversation the companion opened: its id, the voice engine's SDP answer, and the
/// connection that opened it.
struct OpenedSession: Equatable {
    let id: String
    let answer: String
    let connection: CompanionConnection
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
