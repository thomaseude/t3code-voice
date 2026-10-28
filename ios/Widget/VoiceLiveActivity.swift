import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The lock screen and Dynamic Island while a conversation runs: the microphone is on, its
/// status, how long it has run, and the Speaker and End buttons.
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
                if context.state.live { SpeakerButton(on: context.state.speaker) }
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
                    HStack {
                        if context.state.live { SpeakerButton(on: context.state.speaker) }
                        EndButton()
                    }
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

private struct SpeakerButton: View {
    let on: Bool

    var body: some View {
        Button(intent: SpeakerSessionIntent()) {
            Image(systemName: on ? "speaker.wave.3.fill" : "speaker.fill")
                .accessibilityLabel("Haut-parleur")
                .accessibilityValue(on ? "Activé" : "Désactivé")
        }
        .tint(on ? Color.accentColor : Color.secondary)
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
