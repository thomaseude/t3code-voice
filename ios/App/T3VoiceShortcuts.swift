import AppIntents

/// The Siri phrases and the shortcut the Action Button can run. "T3 Voix" is the spoken
/// name of the app (`INAlternativeAppNames` in project.yml). Siri in English uses the phrases
/// of `en.lproj/AppShortcuts.strings`.
struct T3VoiceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartSessionIntent(),
            phrases: [
                "\(.applicationName)",
                "Parler à \(.applicationName)",
                "Démarre \(.applicationName)",
            ],
            shortTitle: "Parler à T3",
            systemImageName: "waveform"
        )
    }
}
