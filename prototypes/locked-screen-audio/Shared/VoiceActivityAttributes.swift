import ActivityKit
import Foundation

struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
        var muted: Bool
        var lastEvent: String
    }

    var startedAt: Date
}
