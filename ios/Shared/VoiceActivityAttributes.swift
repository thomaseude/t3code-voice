import ActivityKit
import Foundation

/// What the Live Activity of a voice conversation shows.
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// The user can talk: the Speaker button only works then, so it is only shown then.
        var live: Bool
        /// The voice goes to the iPhone speaker.
        var speaker: Bool
        /// `SessionState.label`: "Connexion…", "À l'écoute", "En sourdine", "Fin…".
        var status: String
        /// Whether the microphone is muted: the lock screen then shows a crossed-out microphone.
        var muted: Bool
    }

    var startedAt: Date
}
