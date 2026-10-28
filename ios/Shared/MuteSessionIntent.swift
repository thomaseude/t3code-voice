import AppIntents

/// The Mute/Unmute button of the Live Activity. Like the End button, it runs in the app,
/// which holds the call.
struct MuteSessionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Couper ou rétablir le micro"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await Services.session.toggleMute()
        #endif
        return .result()
    }
}
