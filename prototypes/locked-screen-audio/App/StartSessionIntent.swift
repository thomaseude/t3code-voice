import AppIntents

/// Checklist item: can Siri / the Action Button / Shortcuts start recording while the app is
/// backgrounded (not killed)? Expected answer from research: no.
struct StartSessionIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "Start voice test"

    init() {}

    func perform() async throws -> some IntentResult {
        await VoiceSession.shared.start(source: "app-intent")
        return .result()
    }
}

struct ProtoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartSessionIntent(),
            phrases: ["Start voice test in \(.applicationName)"],
            shortTitle: "Start voice test",
            systemImageName: "waveform"
        )
    }
}
