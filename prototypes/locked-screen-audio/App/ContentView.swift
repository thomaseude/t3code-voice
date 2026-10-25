import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var session: VoiceSession
    @EnvironmentObject private var eventLog: EventLog

    @AppStorage(ProtoSettings.Key.model) private var model = ProtoSettings.Default.model
    @AppStorage(ProtoSettings.Key.voice) private var voice = ProtoSettings.Default.voice
    @AppStorage(ProtoSettings.Key.vadEagerness) private var vadEagerness = ProtoSettings.Default.vadEagerness
    @AppStorage(ProtoSettings.Key.voiceChatMode) private var voiceChatMode = ProtoSettings.Default.voiceChatMode
    @AppStorage(ProtoSettings.Key.defaultToSpeaker) private var defaultToSpeaker = ProtoSettings.Default.defaultToSpeaker
    @AppStorage(ProtoSettings.Key.hardMute) private var hardMute = ProtoSettings.Default.hardMute
    @AppStorage(ProtoSettings.Key.pauseOnHeadsetLoss) private var pauseOnHeadsetLoss = ProtoSettings.Default.pauseOnHeadsetLoss
    @AppStorage(ProtoSettings.Key.autoResume) private var autoResume = ProtoSettings.Default.autoResume
    @AppStorage(ProtoSettings.Key.autoReconnect) private var autoReconnect = ProtoSettings.Default.autoReconnect
    @AppStorage(ProtoSettings.Key.announceMinutes) private var announceMinutes = ProtoSettings.Default.announceMinutes
    @AppStorage(ProtoSettings.Key.forcedReconnectMinutes) private var forcedReconnectMinutes = ProtoSettings.Default.forcedReconnectMinutes

    @State private var apiKeyDraft = ""
    @State private var hasKey = Keychain.load() != nil

    var body: some View {
        NavigationStack {
            Form {
                sessionSection
                usageSection
                settingsSection
                apiKeySection
                logSection
            }
            .navigationTitle("Locked audio proto")
        }
    }

    private var sessionSection: some View {
        Section {
            LabeledContent("Status", value: session.status.rawValue)
            if let startedAt = session.startedAt, session.isActive {
                LabeledContent("Running") { Text(startedAt, style: .timer).monospacedDigit() }
            }
            LabeledContent("Call", value: session.callId ?? "–")
            if session.isActive {
                Button(session.muted ? "Unmute" : "Mute") { session.toggleMute(source: "app") }
                Button("Announce now") { session.announce(source: "app") }
                Button("Resume audio") { session.resumeAudio(source: "app") }
                Button("Reconnect now") { session.reconnect(source: "app") }
                Button("Stop session", role: .destructive) { session.stop(source: "app") }
            } else {
                Button("Start session") { Task { await session.start(source: "app") } }
                    .disabled(!hasKey)
            }
        } header: {
            Text("Session")
        } footer: {
            Text("Start with the app on screen, then lock the phone.")
        }
    }

    private var usageSection: some View {
        Section("Usage") {
            let s = session.stats
            LabeledContent("User turns / responses", value: "\(s.userTurns) / \(s.responses)")
            LabeledContent("Announcements", value: "\(s.announcements)")
            LabeledContent("Reconnects / interruptions", value: "\(s.reconnects) / \(s.interruptions)")
            LabeledContent("Audio tokens in / cached / out", value: "\(s.inputAudioTokens) / \(s.cachedAudioTokens) / \(s.outputAudioTokens)")
            LabeledContent("Estimated cost", value: String(format: "$%.3f", session.estimatedCost))
        }
    }

    private var settingsSection: some View {
        Section {
            TextField("Model", text: $model)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Voice", text: $voice)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Picker("VAD eagerness", selection: $vadEagerness) {
                ForEach(["low", "medium", "high", "auto"], id: \.self) { Text($0) }
            }
            Toggle("voiceChat mode (off = default)", isOn: $voiceChatMode)
            Toggle("Speaker when no headset", isOn: $defaultToSpeaker)
            Toggle("Hard mute (stop audio unit)", isOn: $hardMute)
            Toggle("Mute when headset is lost", isOn: $pauseOnHeadsetLoss)
            Toggle("Auto-resume after interruption", isOn: $autoResume)
            Toggle("Auto-reconnect", isOn: $autoReconnect)
            Stepper("Announce every \(announceMinutes) min", value: $announceMinutes, in: 0...30)
            Stepper("Force reconnect every \(forcedReconnectMinutes) min", value: $forcedReconnectMinutes, in: 0...60)
        } header: {
            Text("Settings")
        } footer: {
            Text("Applied at the next start. 0 = off.")
        }
        .disabled(session.isActive)
    }

    private var apiKeySection: some View {
        Section {
            if hasKey {
                LabeledContent("OpenAI key", value: "saved in Keychain")
                Button("Delete key", role: .destructive) {
                    Keychain.delete()
                    hasKey = false
                }
            } else {
                SecureField("sk-…", text: $apiKeyDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Save key") {
                    hasKey = Keychain.save(apiKeyDraft.trimmingCharacters(in: .whitespacesAndNewlines))
                    apiKeyDraft = ""
                }
                .disabled(apiKeyDraft.isEmpty)
            }
        } header: {
            Text("OpenAI API key")
        } footer: {
            Text("Use a dedicated project key with a low budget, and revoke it after the test.")
        }
    }

    private var logSection: some View {
        Section("Log (newest first)") {
            ShareLink(item: eventLog.fileURL) {
                Label("Export log file", systemImage: "square.and.arrow.up")
            }
            ForEach(Array(eventLog.lines.suffix(100).reversed().enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.caption2.monospaced())
            }
        }
    }
}
