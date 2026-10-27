import Foundation

/// What the QR code of `t3-voice pair` holds: `t3voice://pair?url=<companion URL>&code=<one-time code>`.
struct PairingQRCode: Equatable {
    let companionURL: URL
    let code: String

    /// Nil for any other text: another scheme, a companion not on HTTPS, a missing code.
    init?(_ text: String) {
        guard let components = URLComponents(string: text),
              components.scheme == "t3voice", components.host == "pair",
              let items = components.queryItems,
              let address = items.first(where: { $0.name == "url" })?.value,
              let url = URL(string: address), url.scheme == "https", url.host != nil,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
        else { return nil }
        companionURL = url
        self.code = code
    }
}
