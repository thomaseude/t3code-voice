import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The lock screen and Dynamic Island while a conversation runs: the microphone is on or
/// muted, its status, how long it has run, and the Mute/Unmute, Speaker and End buttons.
struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
            HStack(spacing: 12) {
                RecordingIndicator(muted: context.state.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text("T3 Voice").bold()
                    Text(context.state.status).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(context.attributes.startedAt, style: .timer)
                    .monospacedDigit()
                    .frame(maxWidth: 60)
                MuteButton(muted: context.state.muted)
                if context.state.live { SpeakerButton(on: context.state.speaker) }
                EndButton()
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RecordingIndicator(muted: context.state.muted)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.status)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack {
                        MuteButton(muted: context.state.muted)
                        if context.state.live { SpeakerButton(on: context.state.speaker) }
                        EndButton()
                    }
                }
            } compactLeading: {
                RecordingIndicator(muted: context.state.muted)
            } compactTrailing: {
                Text(context.attributes.startedAt, style: .timer)
                    .monospacedDigit()
                    .frame(maxWidth: 44)
            } minimal: {
                RecordingIndicator(muted: context.state.muted)
            }
        }
    }
}

private struct RecordingIndicator: View {
    let muted: Bool

    var body: some View {
        Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
            .foregroundStyle(muted ? Color.secondary : Color.red)
    }
}

private struct MuteButton: View {
    let muted: Bool

    var body: some View {
        Button(intent: MuteSessionIntent()) {
            Image(systemName: muted ? "mic.fill" : "mic.slash.fill")
                .accessibilityLabel(muted ? "Rétablir le micro" : "Couper le micro")
        }
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
