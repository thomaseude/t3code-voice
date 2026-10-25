import AVFoundation
import WebRTC

/// Formatting helpers for log lines. Not actor-isolated so notification callbacks can use them.
enum AudioRoute {
    static let headsetPorts: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .headphones]

    static func describe(_ route: AVAudioSessionRouteDescription) -> String {
        let outputs = route.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
        let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        return "out[\(outputs)] in[\(inputs)]"
    }

    static var current: String { describe(AVAudioSession.sharedInstance().currentRoute) }

    static func hasHeadset(_ route: AVAudioSessionRouteDescription) -> Bool {
        route.outputs.contains { headsetPorts.contains($0.portType) }
    }

    static func name(_ reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .unknown: return "unknown"
        case .newDeviceAvailable: return "newDeviceAvailable"
        case .oldDeviceUnavailable: return "oldDeviceUnavailable"
        case .categoryChange: return "categoryChange"
        case .override: return "override"
        case .wakeFromSleep: return "wakeFromSleep"
        case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
        case .routeConfigurationChange: return "routeConfigurationChange"
        @unknown default: return "raw:\(reason.rawValue)"
        }
    }

    static func name(_ state: RTCPeerConnectionState) -> String {
        switch state {
        case .new: return "new"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .disconnected: return "disconnected"
        case .failed: return "failed"
        case .closed: return "closed"
        @unknown default: return "raw:\(state.rawValue)"
        }
    }

    static func name(_ state: RTCIceConnectionState) -> String {
        switch state {
        case .new: return "new"
        case .checking: return "checking"
        case .connected: return "connected"
        case .completed: return "completed"
        case .failed: return "failed"
        case .disconnected: return "disconnected"
        case .closed: return "closed"
        @unknown default: return "raw:\(state.rawValue)"
        }
    }

    static func name(_ state: RTCDataChannelState) -> String {
        switch state {
        case .connecting: return "connecting"
        case .open: return "open"
        case .closing: return "closing"
        case .closed: return "closed"
        @unknown default: return "raw:\(state.rawValue)"
        }
    }
}
