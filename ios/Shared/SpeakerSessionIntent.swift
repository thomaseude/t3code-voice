import AppIntents

/// The Speaker button of the Live Activity. Like the End button, it runs in the app, which
/// holds the call.
struct SpeakerSessionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Haut-parleur"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await Services.session.toggleSpeaker()
        #endif
        return .result()
    }
}
