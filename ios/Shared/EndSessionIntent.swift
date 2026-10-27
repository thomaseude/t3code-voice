import AppIntents

/// The End button of the Live Activity. It runs in the app, which stays alive through
/// background audio, so only the app target ends the session.
struct EndSessionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Terminer la conversation"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await Services.session.end()
        #endif
        return .result()
    }
}
