import Foundation

struct ProtoError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// PROTOTYPE shortcut: the app mints its own ephemeral key with a standard key from the Keychain.
/// The real app gets the ephemeral key from the companion, which keeps the standard key.
enum RealtimeAPI {
    struct Answer {
        let sdp: String
        let callId: String?
    }

    private static let instructions = """
    Tu es l'assistant vocal d'un prototype de test audio. Réponds toujours en français, \
    en une ou deux phrases courtes. Quand on te demande une annonce, dis-la mot pour mot puis tais-toi.
    """

    static func mintClientSecret(apiKey: String) async throws -> String {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/realtime/client_secrets")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let input: [String: Any] = [
            "noise_reduction": ["type": "near_field"],
            "turn_detection": ["type": "semantic_vad", "eagerness": ProtoSettings.vadEagerness],
        ]
        let audio: [String: Any] = [
            "input": input,
            "output": ["voice": ProtoSettings.voice],
        ]
        let session: [String: Any] = [
            "type": "realtime",
            "model": ProtoSettings.model,
            "instructions": instructions,
            "audio": audio,
        ]
        let expiry: [String: Any] = ["anchor": "created_at", "seconds": 600]
        let body: [String: Any] = ["expires_after": expiry, "session": session]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data, step: "client secret")
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = json["value"] as? String
        else { throw ProtoError("client secret: unexpected response") }
        return value
    }

    static func exchangeSDP(_ offer: String, ephemeralKey: String) async throws -> Answer {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/realtime/calls")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(ephemeralKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(offer.utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data, step: "SDP exchange")
        guard let sdp = String(data: data, encoding: .utf8) else { throw ProtoError("SDP exchange: empty answer") }
        let location = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location")
        return Answer(sdp: sdp, callId: location?.split(separator: "/").last.map(String.init))
    }

    private static func check(_ response: URLResponse, _ data: Data, step: String) throws {
        guard let http = response as? HTTPURLResponse else { throw ProtoError("\(step): no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw ProtoError("\(step): HTTP \(http.statusCode) \(body.prefix(300))")
        }
    }
}
