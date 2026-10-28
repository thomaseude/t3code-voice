import ActivityKit
import Foundation

/// What the Live Activity of a voice conversation shows.
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// The voice goes to the iPhone speaker.
        var speaker: Bool
        /// `SessionState.label`: "Connexion…", "À l'écoute", "Fin…".
        var status: String
    }

    var startedAt: Date
}
