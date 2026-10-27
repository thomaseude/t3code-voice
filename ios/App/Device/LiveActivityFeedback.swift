import ActivityKit
import AVFoundation
import Foundation

/// Shows the session on the Live Activity from the moment the microphone opens, and plays the
/// start sound once the user can talk.
@MainActor
final class LiveActivityFeedback: SessionFeedback {
    private var activity: Activity<VoiceActivityAttributes>?
    private var player: AVAudioPlayer?

    func show(_ state: VoiceSessionState) {
        switch state {
        case .idle:
            end()
        case .authenticating:
            break
        case .connecting:
            start(status: "connexion…")
        case .live:
            playStartSound()
            update(status: "à l'écoute")
        case .ending:
            update(status: "fin…")
        }
    }

    private func start(status: String) {
        // One left over by a crash would show a session that no longer runs.
        for stale in Activity<VoiceActivityAttributes>.activities {
            Task { await stale.end(nil, dismissalPolicy: .immediate) }
        }
        activity = try? Activity.request(
            attributes: VoiceActivityAttributes(startedAt: Date()),
            content: ActivityContent(state: .init(status: status), staleDate: nil),
            pushType: nil
        )
    }

    private func update(status: String) {
        guard let activity else { return }
        Task { await activity.update(ActivityContent(state: .init(status: status), staleDate: nil)) }
    }

    private func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func playStartSound() {
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
