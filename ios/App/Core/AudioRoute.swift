import AVFoundation

/// Which audio route changes count as the AirPods (or another headset) going away.
enum AudioRoute {
    private static let headsets: [AVAudioSession.Port] = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .headphones]

    /// True when the route changed because its device went away and that device was a
    /// headset: iOS would go on with the phone's own microphone.
    static func headsetLost(reason: AVAudioSession.RouteChangeReason?, previousOutputs: [AVAudioSession.Port]) -> Bool {
        reason == .oldDeviceUnavailable && previousOutputs.contains { headsets.contains($0) }
    }
}
