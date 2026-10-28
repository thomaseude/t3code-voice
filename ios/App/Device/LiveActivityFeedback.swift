import ActivityKit
import AVFoundation
import Foundation

/// Shows the session on the Live Activity from the moment the microphone opens, and plays the
/// start sound once the user can talk.
@MainActor
final class LiveActivityFeedback: SessionFeedback {
    // ActivityKit.Activity: the app has its own `Activity` (what T3 runs).
    private var activity: ActivityKit.Activity<VoiceActivityAttributes>?
    private var player: AVAudioPlayer?
    /// What the Live Activity shows. Each event changes its own field and sends the whole
    /// state, so one update never brings back what another replaced.
    private var content = VoiceActivityAttributes.ContentState(live: false, speaker: false, status: "", muted: false)

    func showSpeaker(_ on: Bool) {
        content.speaker = on
        update()
    }

    func show(_ state: SessionState) {
        content.status = state.label ?? ""
        content.live = false
        content.muted = false
        switch state {
        case .idle:
            end()
        case .authenticating:
            break
        case .connecting:
            start()
        case let .live(muted):
            content.live = true
            content.muted = muted
            update()
        case .ending:
            update()
        }
    }

    private func start() {
        end()
        activity = try? ActivityKit.Activity.request(
            attributes: VoiceActivityAttributes(startedAt: Date()),
            content: ActivityContent(state: content, staleDate: nil),
            pushType: nil
        )
    }

    private func update() {
        guard let activity else { return }
        let content = self.content
        Task { await activity.update(ActivityContent(state: content, staleDate: nil)) }
    }

    /// Ends every Live Activity of the app, also one left by a killed process: it would show
    /// a microphone that no longer records.
    private func end() {
        activity = nil
        for leftover in ActivityKit.Activity<VoiceActivityAttributes>.activities {
            Task { await leftover.end(nil, dismissalPolicy: .immediate) }
        }
    }

    func playStartSound() {
        player = try? AVAudioPlayer(data: Self.startSound)
        player?.play()
    }

    /// Two short rising beeps, as a WAV file made in memory: the app ships no sound file.
    private static let startSound: Data = {
        let sampleRate = 16_000
        var samples: [Int16] = []
        for (frequency, seconds) in [(880.0, 0.08), (1320.0, 0.12)] {
            let count = Int(Double(sampleRate) * seconds)
            for index in 0..<count {
                let time = Double(index) / Double(sampleRate)
                // Fades in and out over 5 ms so the beep does not click.
                let fade = min(1, min(time, seconds - time) / 0.005)
                let value = sin(2 * .pi * frequency * time) * fade * 0.4
                samples.append(Int16(value * Double(Int16.max)))
            }
        }
        var wav = Data()
        func append<T: FixedWidthInteger>(_ value: T) {
            withUnsafeBytes(of: value.littleEndian) { wav.append(contentsOf: $0) }
        }
        let dataSize = samples.count * 2
        wav.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + dataSize))
        wav.append(contentsOf: Array("WAVEfmt ".utf8))
        append(UInt32(16)) // format chunk size
        append(UInt16(1)) // PCM
        append(UInt16(1)) // mono
        append(UInt32(sampleRate))
        append(UInt32(sampleRate * 2)) // bytes per second
        append(UInt16(2)) // bytes per frame
        append(UInt16(16)) // bits per sample
        wav.append(contentsOf: Array("data".utf8))
        append(UInt32(dataSize))
        for sample in samples { append(sample) }
        return wav
    }()
}
