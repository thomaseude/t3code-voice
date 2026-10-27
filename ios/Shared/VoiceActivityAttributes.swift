import ActivityKit
import Foundation

/// What the Live Activity of a voice conversation shows.
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// `SessionState.label`: "Connexion…", "À l'écoute", "En sourdine", "Fin…".
        var status: String
        /// Whether the microphone is muted: the button then says "Micro".
        var muted: Bool
    }

    var startedAt: Date
}
