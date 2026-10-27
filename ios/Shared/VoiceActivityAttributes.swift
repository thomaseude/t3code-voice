import ActivityKit
import Foundation

/// What the Live Activity of a voice conversation shows.
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// In French: "connexion…", "à l'écoute", "fin…".
        var status: String
    }

    var startedAt: Date
}
