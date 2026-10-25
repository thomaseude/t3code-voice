import ActivityKit
import Foundation

@MainActor
final class LiveActivityController {
    private var activity: Activity<VoiceActivityAttributes>?

    func start(state: VoiceActivityAttributes.ContentState) {
        for stale in Activity<VoiceActivityAttributes>.activities {
            Task { await stale.end(nil, dismissalPolicy: .immediate) }
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            EventLog.shared.log("Live Activities are disabled in Settings")
            return
        }
        do {
            activity = try Activity.request(
                attributes: VoiceActivityAttributes(startedAt: Date()),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            EventLog.shared.log("live activity started")
        } catch {
            EventLog.shared.log("ERROR live activity start failed: \(error.localizedDescription)")
        }
    }

    func update(_ state: VoiceActivityAttributes.ContentState) {
        guard let activity else { return }
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
