import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The lock screen and Dynamic Island while a conversation runs: the microphone is on, its
/// status, how long it has run, and the End button.
struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
            HStack(spacing: 12) {
                RecordingIndicator()
                VStack(alignment: .leading, spacing: 2) {
                    Text("T3 Voice").bold()
                    Text(context.state.status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(context.attributes.startedAt, style: .timer)
                    .monospacedDigit()
                    .frame(maxWidth: 60)
                EndButton()
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RecordingIndicator()
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.status)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    EndButton()
                }
            } compactLeading: {
                RecordingIndicator()
            } compactTrailing: {
                Text(context.attributes.startedAt, style: .timer)
                    .monospacedDigit()
                    .frame(maxWidth: 44)
            } minimal: {
                RecordingIndicator()
            }
        }
    }
}

private struct RecordingIndicator: View {
    var body: some View {
        Image(systemName: "mic.fill").foregroundStyle(.red)
    }
}

private struct EndButton: View {
    var body: some View {
        Button(intent: EndSessionIntent()) {
            Text("Fin")
        }
        .tint(.red)
    }
}
