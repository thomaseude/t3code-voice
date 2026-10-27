import LocalAuthentication

/// Face ID, with the device passcode when Face ID fails. A new context each time, so every
/// start asks again.
struct FaceIDAuthenticator: Authenticator {
    func authenticate() async -> Bool {
        do {
            return try await LAContext().evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Démarrer une conversation avec T3"
            )
        } catch {
            return false
        }
    }
}
