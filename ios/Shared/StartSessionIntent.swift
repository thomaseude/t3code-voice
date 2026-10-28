import AppIntents

/// Starts a conversation from the Action Button, Siri ("T3 Voix") or the Control Center
/// control, with the same flow as the "Parler" button. iOS unlocks the iPhone, then opens the
/// app, because recording cannot start from the background. Not an `AudioRecordingIntent`:
/// that kind stops the recording when no Live Activity starts, and Live Activities may be off.
/// A running conversation goes on unchanged (decided by Thomas in #27). Both targets build
/// this intent for the control, but only the app runs it.
struct StartSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Parler à T3"
    static let description = IntentDescription("Démarre une conversation vocale avec T3, après Face ID.")
    static let openAppWhenRun = true
    static let authenticationPolicy = IntentAuthenticationPolicy.requiresAuthentication

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        // A separate task: iOS may cancel the intent's task during Face ID, and that cancel
        // would fail the request to the companion.
        await Task { await Services.session.start() }.value
        #endif
        return .result()
    }
}
