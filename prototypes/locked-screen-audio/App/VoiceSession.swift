import AVFoundation
import Foundation
import MediaPlayer
import Network
import UIKit
import WebRTC

/// One long-lived voice session: started in the foreground, kept alive while locked.
/// The prototype owns the audio session (WebRTC manual audio) so we can see who deactivates it.
@MainActor
final class VoiceSession: ObservableObject {
    static let shared = VoiceSession()

    enum Status: String {
        case idle, starting, connecting, live, interrupted, reconnecting, stopped
    }

    struct Stats {
        var userTurns = 0
        var responses = 0
        var announcements = 0
        var reconnects = 0
        var interruptions = 0
        var inputAudioTokens = 0
        var inputTextTokens = 0
        var cachedAudioTokens = 0
        var cachedTextTokens = 0
        var outputAudioTokens = 0
        var outputTextTokens = 0
    }

    @Published private(set) var isActive = false
    @Published private(set) var status: Status = .idle {
        didSet { if oldValue != status { updateActivity(status.rawValue) } }
    }
    @Published private(set) var muted = false
    @Published private(set) var startedAt: Date?
    @Published private(set) var callId: String?
    @Published private(set) var stats = Stats()

    private let log = EventLog.shared
    private let liveActivity = LiveActivityController()
    private lazy var observer = PeerObserver(owner: self)
    private var factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var localTrack: RTCAudioTrack?
    private var timers: [Timer] = []
    private var notificationTokens: [NSObjectProtocol] = []
    private var remoteCommandTargets: [(MPRemoteCommand, Any)] = []
    private var pathMonitor: NWPathMonitor?
    private var reconnectAttempt = 0
    private var reconnectPending = false
    private var disconnectedSince: Date?
    private var batteryAtStart: Float = -1

    private init() {}

    // MARK: - Lifecycle

    func start(source: String) async {
        guard !isActive else {
            log.log("start ignored (already active) source=\(source)")
            return
        }
        log.log("START requested source=\(source)")
        guard Keychain.load() != nil else {
            log.log("ERROR no API key saved")
            return
        }
        status = .starting
        guard await AVAudioApplication.requestRecordPermission() else {
            log.log("ERROR microphone permission denied")
            status = .idle
            return
        }
        do {
            try activateAudioSession()
        } catch {
            log.log("ERROR audio session activation failed: \(error.localizedDescription)")
            status = .idle
            return
        }
        isActive = true
        startedAt = Date()
        stats = Stats()
        muted = false
        UIDevice.current.isBatteryMonitoringEnabled = true
        batteryAtStart = UIDevice.current.batteryLevel
        installObservers()
        installRemoteCommands()
        startTimers()
        liveActivity.start(state: activityState("starting"))
        await connect(reason: "start")
    }

    func stop(source: String) {
        guard isActive else { return }
        isActive = false
        let minutes = startedAt.map { Date().timeIntervalSince($0) / 60 } ?? 0
        let batteryNow = UIDevice.current.batteryLevel
        log.log(String(format: "STOP source=%@ duration=%.1fmin battery %.0f%% -> %.0f%% est. cost $%.3f",
                       source, minutes, batteryAtStart * 100, batteryNow * 100, estimatedCost))
        timers.forEach { $0.invalidate() }
        timers = []
        for token in notificationTokens { NotificationCenter.default.removeObserver(token) }
        notificationTokens = []
        for (command, target) in remoteCommandTargets { command.removeTarget(target) }
        remoteCommandTargets = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        teardownPeer()
        let rtc = RTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        rtc.lockForConfiguration()
        do {
            try rtc.setActive(false)
        } catch {
            log.log("audio session deactivation error: \(error.localizedDescription)")
        }
        rtc.unlockForConfiguration()
        status = .stopped
        liveActivity.end()
    }

    private func activateAudioSession() throws {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.useManualAudio = true
        rtc.isAudioEnabled = false
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = (ProtoSettings.voiceChatMode ? AVAudioSession.Mode.voiceChat : AVAudioSession.Mode.default).rawValue
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP]
        if ProtoSettings.defaultToSpeaker { options.insert(.defaultToSpeaker) }
        config.categoryOptions = options
        RTCAudioSessionConfiguration.setWebRTC(config)
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        try rtc.setConfiguration(config, active: true)
        rtc.isAudioEnabled = true
        log.log("audio session active mode=\(config.mode) route=\(AudioRoute.current)")
    }

    // MARK: - Connection

    private func connect(reason: String) async {
        guard isActive else { return }
        status = reason == "start" ? .connecting : .reconnecting
        log.log("connect reason=\(reason)")
        do {
            guard let apiKey = Keychain.load() else { throw ProtoError("API key unreadable from Keychain") }
            let secret = try await RealtimeAPI.mintClientSecret(apiKey: apiKey)
            guard isActive else { return }
            let pc = try makePeer()
            let offer = try await pc.protoOffer()
            try await pc.protoSetLocal(offer)
            for _ in 0..<30 where pc.iceGatheringState != .complete {
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard let localSdp = pc.localDescription?.sdp else { throw ProtoError("no local SDP") }
            let answer = try await RealtimeAPI.exchangeSDP(localSdp, ephemeralKey: secret)
            guard isActive, pc === peer else { return }
            try await pc.protoSetRemote(RTCSessionDescription(type: .answer, sdp: answer.sdp))
            callId = answer.callId
            applyMute()
            log.log("SDP exchanged call=\(answer.callId ?? "?")")
        } catch {
            log.log("ERROR connect failed: \(error.localizedDescription)")
            teardownPeer()
            scheduleReconnect(reason: "connect-failed")
        }
    }

    private func makePeer() throws -> RTCPeerConnection {
        if factory == nil {
            RTCInitializeSSL()
            factory = RTCPeerConnectionFactory()
        }
        guard let factory else { throw ProtoError("no peer connection factory") }
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: observer) else {
            throw ProtoError("peer connection creation failed")
        }
        let track = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "mic0")
        pc.add(track, streamIds: ["proto"])
        let channel = pc.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        channel?.delegate = observer
        peer = pc
        dataChannel = channel
        localTrack = track
        return pc
    }

    private func teardownPeer() {
        dataChannel?.delegate = nil
        dataChannel?.close()
        dataChannel = nil
        peer?.close()
        peer = nil
        localTrack = nil
        callId = nil
        disconnectedSince = nil
    }

    func reconnect(source: String) {
        guard isActive else { return }
        stats.reconnects += 1
        log.log("reconnect requested source=\(source)")
        teardownPeer()
        Task { await connect(reason: source) }
    }

    private func scheduleReconnect(reason: String) {
        guard isActive else { return }
        status = .reconnecting
        guard ProtoSettings.autoReconnect else {
            log.log("auto-reconnect off, waiting (reason=\(reason))")
            return
        }
        guard !reconnectPending else { return }
        reconnectPending = true
        reconnectAttempt += 1
        let delays: [Double] = [1, 2, 5, 10, 30]
        let delay = delays[min(reconnectAttempt - 1, delays.count - 1)]
        log.log("auto-reconnect in \(Int(delay))s attempt=\(reconnectAttempt) reason=\(reason)")
        Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            reconnectPending = false
            guard isActive else { return }
            stats.reconnects += 1
            teardownPeer()
            await connect(reason: "auto:\(reason)")
        }
    }

    // MARK: - WebRTC events (forwarded by PeerObserver)

    func peerStateChanged(_ id: ObjectIdentifier, state: RTCPeerConnectionState) {
        guard let peer, ObjectIdentifier(peer) == id else { return }
        log.log("peer state=\(AudioRoute.name(state))")
        switch state {
        case .connected:
            disconnectedSince = nil
            reconnectAttempt = 0
            if status != .interrupted { status = .live }
        case .disconnected:
            disconnectedSince = Date()
        case .failed:
            scheduleReconnect(reason: "peer-failed")
        default:
            break
        }
    }

    func iceStateChanged(_ id: ObjectIdentifier, state: RTCIceConnectionState) {
        guard let peer, ObjectIdentifier(peer) == id else { return }
        log.log("ice state=\(AudioRoute.name(state))")
    }

    func dataChannelStateChanged(_ id: ObjectIdentifier, state: RTCDataChannelState) {
        guard let dataChannel, ObjectIdentifier(dataChannel) == id else { return }
        log.log("data channel=\(AudioRoute.name(state))")
        if state == .closed { scheduleReconnect(reason: "data-channel-closed") }
    }

    func handleServerEvent(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = json["type"] as? String
        else { return }
        switch type {
        case "session.created", "session.updated",
             "output_audio_buffer.started", "output_audio_buffer.stopped", "output_audio_buffer.cleared":
            log.log("event \(type)")
        case "input_audio_buffer.speech_started":
            stats.userTurns += 1
            log.log("user speech started (turn #\(stats.userTurns))")
        case "input_audio_buffer.speech_stopped":
            log.log("user speech stopped")
        case "response.done":
            handleResponseDone(json["response"] as? [String: Any] ?? [:])
        case "error":
            let message = (json["error"] as? [String: Any])?["message"] as? String ?? text
            log.log("SERVER ERROR \(message)")
        default:
            break
        }
    }

    private func handleResponseDone(_ response: [String: Any]) {
        stats.responses += 1
        if let usage = response["usage"] as? [String: Any] {
            let input = usage["input_token_details"] as? [String: Any] ?? [:]
            let cached = input["cached_tokens_details"] as? [String: Any] ?? [:]
            let output = usage["output_token_details"] as? [String: Any] ?? [:]
            stats.inputAudioTokens += input["audio_tokens"] as? Int ?? 0
            stats.inputTextTokens += input["text_tokens"] as? Int ?? 0
            stats.cachedAudioTokens += cached["audio_tokens"] as? Int ?? 0
            stats.cachedTextTokens += cached["text_tokens"] as? Int ?? 0
            stats.outputAudioTokens += output["audio_tokens"] as? Int ?? 0
            stats.outputTextTokens += output["text_tokens"] as? Int ?? 0
        }
        var transcript = ""
        for item in response["output"] as? [[String: Any]] ?? [] {
            for part in item["content"] as? [[String: Any]] ?? [] {
                transcript += part["transcript"] as? String ?? ""
            }
        }
        let status = response["status"] as? String ?? "?"
        log.log("response.done status=\(status) said=\"\(transcript.prefix(120))\"")
        updateActivity("said: \(transcript.prefix(40))")
    }

    /// Rough $ estimate from the per-1M prices in research/voice-engine.md. Cached text is priced like cached audio.
    var estimatedCost: Double {
        let full = ProtoSettings.model == "gpt-realtime-2.1"
        let audioIn = full ? 32.0 : 10.0, cachedIn = full ? 0.40 : 0.30, audioOut = full ? 64.0 : 20.0
        let textIn = full ? 4.0 : 0.60, textOut = full ? 24.0 : 2.40
        let s = stats
        let dollars = Double(s.inputAudioTokens - s.cachedAudioTokens) * audioIn
            + Double(s.cachedAudioTokens + s.cachedTextTokens) * cachedIn
            + Double(s.inputTextTokens - s.cachedTextTokens) * textIn
            + Double(s.outputAudioTokens) * audioOut
            + Double(s.outputTextTokens) * textOut
        return dollars / 1_000_000
    }

    // MARK: - Controls

    func toggleMute(source: String) {
        setMuted(!muted, source: source)
    }

    func setMuted(_ value: Bool, source: String) {
        guard isActive, value != muted else { return }
        muted = value
        applyMute()
        log.log("\(muted ? "MUTED" : "UNMUTED") source=\(source) hard=\(ProtoSettings.hardMute)")
        updateActivity(muted ? "muted" : "unmuted")
    }

    private func applyMute() {
        localTrack?.isEnabled = !muted
        let remote = peer?.transceivers.first(where: { $0.mediaType == .audio })?.receiver.track as? RTCAudioTrack
        remote?.isEnabled = !muted
        if ProtoSettings.hardMute {
            RTCAudioSession.sharedInstance().isAudioEnabled = !muted
        }
    }

    /// Reactivates the audio session and restarts WebRTC audio. The key unknown: does this work from background?
    func resumeAudio(source: String) {
        guard isActive else {
            log.log("resume ignored (no session) source=\(source)")
            return
        }
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        do {
            try rtc.setActive(true)
            rtc.isAudioEnabled = false
            rtc.isAudioEnabled = !(muted && ProtoSettings.hardMute)
            status = peer?.connectionState == .connected ? .live : .reconnecting
            log.log("RESUME OK source=\(source) route=\(AudioRoute.current)")
            updateActivity("resumed")
        } catch {
            log.log("RESUME FAILED source=\(source) error=\(error.localizedDescription)")
            updateActivity("resume failed")
        }
    }

    func announce(source: String) {
        guard let channel = dataChannel, channel.readyState == .open else {
            log.log("announce skipped (data channel not open) source=\(source)")
            return
        }
        guard !muted else {
            log.log("announce skipped (muted) source=\(source)")
            return
        }
        stats.announcements += 1
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .short)
        let text = "La tâche de test numéro \(stats.announcements) est terminée. Il est \(time)."
        let response: [String: Any] = ["instructions": "Dis exactement, en français : « \(text) » Puis tais-toi."]
        let event: [String: Any] = ["type": "response.create", "response": response]
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        else {
            log.log("ERROR announce send failed")
            return
        }
        log.log("ANNOUNCE #\(stats.announcements) sent source=\(source)")
    }

    // MARK: - Observers and timers

    private func startTimers() {
        timers.append(Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.heartbeat() }
        })
        let announceMinutes = ProtoSettings.announceMinutes
        if announceMinutes > 0 {
            timers.append(Timer.scheduledTimer(withTimeInterval: TimeInterval(announceMinutes * 60), repeats: true) { [weak self] _ in
                Task { @MainActor in self?.announce(source: "timer") }
            })
        }
        let reconnectMinutes = ProtoSettings.forcedReconnectMinutes
        if reconnectMinutes > 0 {
            timers.append(Timer.scheduledTimer(withTimeInterval: TimeInterval(reconnectMinutes * 60), repeats: true) { [weak self] _ in
                Task { @MainActor in self?.reconnect(source: "forced-timer") }
            })
        }
    }

    private func heartbeat() {
        guard isActive else { return }
        if let since = disconnectedSince, Date().timeIntervalSince(since) > 10 {
            disconnectedSince = nil
            scheduleReconnect(reason: "disconnected-10s")
        }
        let rtc = RTCAudioSession.sharedInstance()
        let elapsed = startedAt.map { Int(Date().timeIntervalSince($0) / 60) } ?? 0
        let peerState = peer.map { AudioRoute.name($0.connectionState) } ?? "none"
        log.log("hb status=\(status.rawValue) peer=\(peerState) audioActive=\(rtc.isActive) audioEnabled=\(rtc.isAudioEnabled) muted=\(muted) route=\(AudioRoute.current) battery=\(Int(UIDevice.current.batteryLevel * 100))% elapsed=\(elapsed)min")
    }

    private func installObservers() {
        let center = NotificationCenter.default
        let audio = AVAudioSession.sharedInstance()

        notificationTokens.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: audio, queue: .main) { [weak self] note in
            let info = note.userInfo ?? [:]
            let type = info[AVAudioSessionInterruptionTypeKey] as? UInt
            let options = info[AVAudioSessionInterruptionOptionKey] as? UInt
            let reason = info[AVAudioSessionInterruptionReasonKey] as? UInt
            Task { @MainActor in self?.handleInterruption(type: type, options: options, reason: reason) }
        })

        notificationTokens.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: audio, queue: .main) { [weak self] note in
            let info = note.userInfo ?? [:]
            let reason = (info[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            let previous = info[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let previousText = previous.map(AudioRoute.describe) ?? "?"
            let previousHadHeadset = previous.map(AudioRoute.hasHeadset) ?? false
            Task { @MainActor in
                self?.handleRouteChange(reason: reason, previous: previousText, previousHadHeadset: previousHadHeadset)
            }
        })

        notificationTokens.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: audio, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.log.log("MEDIA SERVICES WERE RESET (session must be rebuilt)") }
        })

        let appEvents: [(Notification.Name, String)] = [
            (UIApplication.didEnterBackgroundNotification, "app entered background"),
            (UIApplication.willEnterForegroundNotification, "app will enter foreground"),
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "DEVICE LOCKED"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "DEVICE UNLOCKED"),
        ]
        for (name, label) in appEvents {
            notificationTokens.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.log.log(label) }
            })
        }

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let text = "network \(path.status) wifi=\(path.usesInterfaceType(.wifi)) cellular=\(path.usesInterfaceType(.cellular))"
            Task { @MainActor in self?.log.log(text) }
        }
        monitor.start(queue: DispatchQueue(label: "proto.network"))
        pathMonitor = monitor
    }

    private func handleInterruption(type: UInt?, options: UInt?, reason: UInt?) {
        guard isActive else { return }
        if type == AVAudioSession.InterruptionType.began.rawValue {
            stats.interruptions += 1
            status = .interrupted
            log.log("INTERRUPTION BEGAN reason=\(reason.map { String($0) } ?? "nil")")
        } else if type == AVAudioSession.InterruptionType.ended.rawValue {
            let shouldResume = ((options ?? 0) & AVAudioSession.InterruptionOptions.shouldResume.rawValue) != 0
            log.log("INTERRUPTION ENDED shouldResume=\(shouldResume)")
            if ProtoSettings.autoResume {
                resumeAudio(source: "interruption-ended")
            } else {
                updateActivity("interrupted, tap Resume")
            }
        }
    }

    private func handleRouteChange(reason: AVAudioSession.RouteChangeReason?, previous: String, previousHadHeadset: Bool) {
        guard isActive else { return }
        log.log("ROUTE CHANGE reason=\(reason.map { AudioRoute.name($0) } ?? "?") from=\(previous) to=\(AudioRoute.current)")
        if reason == .oldDeviceUnavailable, previousHadHeadset, ProtoSettings.pauseOnHeadsetLoss {
            setMuted(true, source: "headset-lost")
        }
    }

    private func installRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        let commands: [(MPRemoteCommand, String, Bool?)] = [
            (center.togglePlayPauseCommand, "togglePlayPause", nil),
            (center.playCommand, "play", false),
            (center.pauseCommand, "pause", true),
        ]
        for (command, name, mute) in commands {
            command.isEnabled = true
            let target = command.addTarget { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.log.log("REMOTE COMMAND \(name)")
                    self.setMuted(mute ?? !self.muted, source: "remote-\(name)")
                }
                return .success
            }
            remoteCommandTargets.append((command, target))
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Voice proto",
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
    }

    // MARK: - Live Activity

    private func activityState(_ lastEvent: String) -> VoiceActivityAttributes.ContentState {
        VoiceActivityAttributes.ContentState(status: status.rawValue, muted: muted, lastEvent: lastEvent)
    }

    private func updateActivity(_ lastEvent: String) {
        liveActivity.update(activityState(lastEvent))
    }
}
