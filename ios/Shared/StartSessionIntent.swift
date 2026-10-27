import AppIntents

/// Starts a conversation from the Action Button, Siri ("T3 Voix") or the Control Center
/// control, with the same flow as the "Parler" button. iOS asks to unlock the iPhone first,
/// then opens the app: recording cannot start from the background. So this is a plain
/// `AppIntent`: an `AudioRecordingIntent` would stop the recording when no Live Activity
/// starts, and the "Parler" button records without one when Live Activities are off.
/// A running conversation goes on unchanged (decided by Thomas in #27). The control lives in
/// the widget extension, so both targets build this intent, but only the app runs it.
struct StartSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Parler à T3"
    static let description = IntentDescription("Démarre une conversation vocale avec T3, après Face ID.")
    static let openAppWhenRun = true
    static let authenticationPolicy = IntentAuthenticationPolicy.requiresAuthentication

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        // Not in this task: iOS may cancel it during Face ID, and the cancel would fail the
        // request to the companion.
        await Task { await Services.session.start() }.value
        #endif
        return .result()
    }
}
