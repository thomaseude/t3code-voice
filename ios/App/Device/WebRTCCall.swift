import AVFoundation
import WebRTC

/// One WebRTC call to the voice engine: the microphone, the audio session, and the
/// `oai-events` data channel. The audio session is activated at start, in the foreground,
/// and only deactivated by `hangUp`.
@MainActor
final class WebRTCCall: VoiceCall {
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    private var peer: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    /// WebRTC keeps only a weak reference to its delegate.
    private var observer: CallObserver?
    private var hungUp = false
    /// Only the call that activated the audio session deactivates it.
    private var audioActive = false

    func start(onEvent: @escaping @MainActor (VoiceCallEvent) async -> Void) async throws -> String {
        guard await AVAudioApplication.requestRecordPermission() else { throw VoiceCallError.microphoneDenied }
        do {
            // End may come while iOS asks for the microphone, or while WebRTC makes the offer.
            try stopIfHungUp()
            try activateAudioSession()
            let observer = CallObserver(onEvent: onEvent)
            self.observer = observer
            let peer = try makePeer(observer: observer)
            let offer = try await peer.makeOffer()
            try stopIfHungUp()
            try await peer.setLocal(offer)
            try stopIfHungUp()
            // The offer goes out now: the voice engine does not need every ICE candidate.
            guard let sdp = peer.localDescription?.sdp else { throw VoiceCallError.failed }
            return sdp
        } catch let error as VoiceCallError {
            throw error
        } catch {
            throw VoiceCallError.failed
        }
    }

    func accept(answer: String) async throws {
        guard let peer else { throw VoiceCallError.failed }
        do {
            try await peer.setRemote(RTCSessionDescription(type: .answer, sdp: answer))
        } catch {
            throw VoiceCallError.failed
        }
    }

    func hangUp() {
        hungUp = true
        release()
    }

    private func stopIfHungUp() throws {
        guard hungUp else { return }
        release()
        throw VoiceCallError.failed
    }

    /// Closes the connection and the microphone, and deactivates the audio session.
    private func release() {
        dataChannel?.delegate = nil
        dataChannel?.close()
        dataChannel = nil
        peer?.close()
        peer = nil
        observer = nil
        guard audioActive else { return }
        audioActive = false
        let audio = RTCAudioSession.sharedInstance()
        audio.isAudioEnabled = false
        audio.lockForConfiguration()
        try? audio.setActive(false)
        audio.unlockForConfiguration()
    }

    /// `.playAndRecord` / `.voiceChat` / `.allowBluetoothHFP`, with WebRTC in manual audio:
    /// the app, not WebRTC, decides when the audio session is active.
    private func activateAudioSession() throws {
        let audio = RTCAudioSession.sharedInstance()
        audio.useManualAudio = true
        audio.isAudioEnabled = false
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.voiceChat.rawValue
        config.categoryOptions = [.allowBluetoothHFP]
        RTCAudioSessionConfiguration.setWebRTC(config)
        audio.lockForConfiguration()
        defer { audio.unlockForConfiguration() }
        try audio.setConfiguration(config, active: true)
        audioActive = true
        audio.isAudioEnabled = true
    }

    private func makePeer(observer: CallObserver) throws -> RTCPeerConnection {
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: config, constraints: constraints, delegate: observer) else {
            throw VoiceCallError.failed
        }
        let microphone = Self.factory.audioTrack(with: Self.factory.audioSource(with: constraints), trackId: "mic")
        peer.add(microphone, streamIds: ["t3voice"])
        let channel = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        channel?.delegate = observer
        self.peer = peer
        dataChannel = channel
        return peer
    }
}

/// WebRTC calls its delegates on its own threads: this passes the events that matter to the
/// main actor, in the order they came, and only the first one that ends the call (the data
/// channel closes right after `session.closed`). It reads only the type of each data channel
/// message, never its content.
private final class CallObserver: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    private let events: AsyncStream<VoiceCallEvent>.Continuation
    private let lock = NSLock()
    private var ended = false

    init(onEvent: @escaping @MainActor (VoiceCallEvent) async -> Void) {
        let (stream, events) = AsyncStream.makeStream(of: VoiceCallEvent.self)
        self.events = events
        super.init()
        Task { @MainActor in
            for await event in stream { await onEvent(event) }
        }
    }

    deinit {
        events.finish()
    }

    private func report(_ event: VoiceCallEvent) {
        lock.lock()
        defer { lock.unlock() }
        guard !ended else { return }
        if event != .sessionStarted { ended = true }
        events.yield(event)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        if newState == .failed { report(.lost) }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        if dataChannel.readyState == .closed { report(.lost) }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let message = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "session.started": report(.sessionStarted)
        case "session.closed": report(.sessionClosed)
        default: break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

private extension RTCPeerConnection {
    func makeOffer() async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, error in
                if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: error ?? VoiceCallError.failed)
                }
            }
        }
    }

    func setLocal(_ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            setLocalDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func setRemote(_ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            setRemoteDescription(sdp) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
}
