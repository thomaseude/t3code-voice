import AppIntents

// Compiled into both targets. LiveActivityIntent.perform runs in the app process,
// so only the app target references VoiceSession.

struct ToggleMuteIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Toggle mute"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { VoiceSession.shared.toggleMute(source: "live-activity") }
        #endif
        return .result()
    }
}

struct ResumeAudioIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Resume audio"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { VoiceSession.shared.resumeAudio(source: "live-activity") }
        #endif
        return .result()
    }
}

struct EndSessionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "End session"

    init() {}

    func perform() async throws -> some IntentResult {
        #if !WIDGET_EXTENSION
        await MainActor.run { VoiceSession.shared.stop(source: "live-activity") }
        #endif
        return .result()
    }
}
