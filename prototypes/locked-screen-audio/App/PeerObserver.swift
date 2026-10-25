import Foundation
import WebRTC

/// WebRTC calls its delegates on its own threads. This forwards what matters to the main actor.
final class PeerObserver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    weak var owner: VoiceSession?

    init(owner: VoiceSession) {
        self.owner = owner
        super.init()
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        let id = ObjectIdentifier(peerConnection)
        let owner = owner
        Task { @MainActor in owner?.peerStateChanged(id, state: newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let id = ObjectIdentifier(peerConnection)
        let owner = owner
        Task { @MainActor in owner?.iceStateChanged(id, state: newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        let id = ObjectIdentifier(dataChannel)
        let state = dataChannel.readyState
        let owner = owner
        Task { @MainActor in owner?.dataChannelStateChanged(id, state: state) }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let text = String(data: buffer.data, encoding: .utf8) else { return }
        let owner = owner
        Task { @MainActor in owner?.handleServerEvent(text) }
    }
}

extension RTCPeerConnection {
    func protoOffer() async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, error in
                if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: error ?? ProtoError("createOffer failed"))
                }
            }
        }
    }

    func protoSetLocal(_ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            setLocalDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func protoSetRemote(_ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            setRemoteDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
}
