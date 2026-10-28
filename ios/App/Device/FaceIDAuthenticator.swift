import LocalAuthentication

/// Face ID, with the device passcode when Face ID fails. A new context each time, so every
/// start asks again, unless the iPhone was unlocked with Face ID in the last 10 seconds: a
/// trigger from the locked iPhone (Action Button, Siri, Control Center) then asks only once,
/// when iOS unlocks it (decided by Thomas in #27). An unlock with the passcode does not count.
struct FaceIDAuthenticator: Authenticator {
    func authenticate() async -> Bool {
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 10
        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Démarrer une conversation avec T3"
            )
        } catch {
            return false
        }
    }
}
