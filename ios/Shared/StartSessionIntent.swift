import AppIntents

/// Starts a conversation from the Action Button, Siri ("T3 Voix") or the Control Center
/// control, with the same flow as the "Parler" button. iOS asks to unlock the iPhone first,
/// then opens the app: recording cannot start from the background. A running conversation
/// goes on unchanged (decided by Thomas in #27). The control lives in the widget extension,
/// so both targets build this intent, but only the app runs it.
struct StartSessionIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "Parler à T3"
    static let description = IntentDescription("Démarre une conversation vocale avec T3, après Face ID.")
    static let openAppWhenRun = true
    static let authenticationPolicy = IntentAuthenticationPolicy.requiresAuthentication

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await Services.session.start()
        #endif
        return .result()
    }
}
