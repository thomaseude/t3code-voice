import Foundation

/// Settings read when a session starts. The UI writes them with @AppStorage using the same keys and defaults.
enum ProtoSettings {
    enum Key {
        static let model = "model"
        static let voice = "voice"
        static let vadEagerness = "vadEagerness"
        static let voiceChatMode = "voiceChatMode"
        static let defaultToSpeaker = "defaultToSpeaker"
        static let hardMute = "hardMute"
        static let pauseOnHeadsetLoss = "pauseOnHeadsetLoss"
        static let autoResume = "autoResume"
        static let autoReconnect = "autoReconnect"
        static let announceMinutes = "announceMinutes"
        static let forcedReconnectMinutes = "forcedReconnectMinutes"
    }

    enum Default {
        static let model = "gpt-realtime-2.1-mini"
        static let voice = "marin"
        static let vadEagerness = "low"
        static let voiceChatMode = true
        static let defaultToSpeaker = true
        static let hardMute = false
        static let pauseOnHeadsetLoss = true
        static let autoResume = true
        static let autoReconnect = true
        static let announceMinutes = 5
        static let forcedReconnectMinutes = 0
    }

    private static var defaults: UserDefaults { .standard }

    static var model: String { defaults.string(forKey: Key.model) ?? Default.model }
    static var voice: String { defaults.string(forKey: Key.voice) ?? Default.voice }
    static var vadEagerness: String { defaults.string(forKey: Key.vadEagerness) ?? Default.vadEagerness }
    static var voiceChatMode: Bool { bool(Key.voiceChatMode, Default.voiceChatMode) }
    static var defaultToSpeaker: Bool { bool(Key.defaultToSpeaker, Default.defaultToSpeaker) }
    static var hardMute: Bool { bool(Key.hardMute, Default.hardMute) }
    static var pauseOnHeadsetLoss: Bool { bool(Key.pauseOnHeadsetLoss, Default.pauseOnHeadsetLoss) }
    static var autoResume: Bool { bool(Key.autoResume, Default.autoResume) }
    static var autoReconnect: Bool { bool(Key.autoReconnect, Default.autoReconnect) }
    static var announceMinutes: Int { int(Key.announceMinutes, Default.announceMinutes) }
    static var forcedReconnectMinutes: Int { int(Key.forcedReconnectMinutes, Default.forcedReconnectMinutes) }

    private static func bool(_ key: String, _ fallback: Bool) -> Bool {
        defaults.object(forKey: key) as? Bool ?? fallback
    }

    private static func int(_ key: String, _ fallback: Int) -> Int {
        defaults.object(forKey: key) as? Int ?? fallback
    }
}
