import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: context.state.muted ? "mic.slash.fill" : "waveform")
                    Text("Voice proto").bold()
                    Spacer()
                    Text(context.attributes.startedAt, style: .timer)
                        .monospacedDigit()
                        .frame(maxWidth: 70)
                }
                Text("\(context.state.status) — \(context.state.lastEvent)")
                    .font(.caption)
                    .lineLimit(1)
                HStack {
                    Button(intent: ToggleMuteIntent()) {
                        Text(context.state.muted ? "Unmute" : "Mute")
                    }
                    Button(intent: ResumeAudioIntent()) {
                        Text("Resume")
                    }
                    Button(intent: EndSessionIntent()) {
                        Text("End")
                    }
                    .tint(.red)
                }
                .font(.caption)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    Text("\(context.state.status) — \(context.state.lastEvent)")
                        .font(.caption)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Button(intent: ToggleMuteIntent()) {
                            Text(context.state.muted ? "Unmute" : "Mute")
                        }
                        Button(intent: ResumeAudioIntent()) {
                            Text("Resume")
                        }
                        Button(intent: EndSessionIntent()) {
                            Text("End")
                        }
                    }
                    .font(.caption)
                }
            } compactLeading: {
                Image(systemName: context.state.muted ? "mic.slash.fill" : "waveform")
            } compactTrailing: {
                Text(context.state.status.prefix(4))
                    .font(.caption2)
            } minimal: {
                Image(systemName: "waveform")
            }
        }
    }
}
