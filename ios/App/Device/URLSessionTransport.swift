import Foundation

/// Sends the requests over the network with URLSession.
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
