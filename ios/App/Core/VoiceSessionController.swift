import Foundation

/// Where a voice conversation is, from the user's point of view (spec #15, "Session state
/// machine"). Interruption, reconnection and suspension come with #26.
enum SessionState: Equatable {
    case idle
    /// Face ID is on screen.
    case authenticating
    /// The microphone is open and the companion opens the session with the voice engine.
    case connecting
    case live
    case ending(EndReason)

    /// What the screen and the Live Activity say about the session. Nil when no session runs.
    var label: String? {
        switch self {
        case .idle, .authenticating: nil
        case .connecting: "Connexion…"
        case .live: "À l'écoute"
        case .ending: "Fin…"
        }
    }
}

enum EndReason: Equatable {
    /// The End button, in the app or on the Live Activity.
    case user
    /// `session.closed` arrived: the companion closed it. Most often the voice model ended it
    /// ("fin", "c'est bon, merci"), but the companion also closes it when the device is
    /// revoked, when `serve` stops, or when a newer session replaces it. The phone cannot
    /// tell these apart.
    case voice
    case error(SessionFailure)
}

enum SessionFailure: Equatable {
    case microphoneDenied
    case unauthorized
    case limited
    case voiceUnavailable
    case voiceEngineFailed
    case companionUnreachable
    /// The companion answered with a status the app does not expect.
    case companionRefused(status: Int)
    /// WebRTC could not make the offer or apply the answer.
    case callFailed
    /// The connection to the voice engine dropped.
    case lost

    var message: String {
        switch self {
        case .microphoneDenied: "Autorise le micro dans Réglages > T3 Voice."
        case .unauthorized: "Le companion a refusé cet iPhone. Appaire-le de nouveau."
        case .limited: "Trop de requêtes. Réessaie dans un instant."
        case .voiceUnavailable: "La voix est désactivée sur le companion : il n'a pas de clé OpenAI."
        case .voiceEngineFailed: "OpenAI n'a pas ouvert la session. Réessaie dans un instant."
        case .companionUnreachable: "Le companion ne répond pas."
        case let .companionRefused(status): "Le companion a répondu une erreur (\(status))."
        case .callFailed: "La connexion audio n'a pas pu s'établir."
        case .lost: "La connexion audio a été coupée."
        }
    }

    init(_ error: Error) {
        switch error {
        case VoiceCallError.microphoneDenied: self = .microphoneDenied
        case VoiceCallError.failed: self = .callFailed
        case CompanionError.unauthorized, CompanionError.notPaired: self = .unauthorized
        case CompanionError.limited: self = .limited
        case CompanionError.voiceUnavailable: self = .voiceUnavailable
        case CompanionError.voiceEngineFailed: self = .voiceEngineFailed
        case let CompanionError.unexpected(status): self = .companionRefused(status: status)
        default: self = .companionUnreachable
        }
    }
}

/// Face ID, or the device passcode when Face ID fails.
protocol Authenticator {
    func authenticate() async -> Bool
}

enum VoiceCallError: Error {
    case microphoneDenied
    case failed
}

/// What the voice engine reports on the call.
enum VoiceCallEvent {
    /// `session.started` on the data channel: the phone may talk.
    case sessionStarted
    /// `session.closed` on the data channel: the session ended on the voice engine's side.
    case sessionClosed
    /// The audio route changed: a headset came or went, or the speaker was turned on or off.
    case routeChanged
    /// The peer connection or the data channel failed.
    case lost
}

/// One WebRTC call to the voice engine, with the audio session. A new one for each session.
@MainActor
protocol VoiceCall: AnyObject {
    /// Opens the microphone and returns the SDP offer, without waiting for full ICE gathering.
    func start(onEvent: @escaping @MainActor (VoiceCallEvent) async -> Void) async throws -> String
    func accept(answer: String) async throws
    /// Sends the voice to the iPhone speaker, or back to the earpiece or the headset. It
    /// changes only the output: the audio session stays active.
    func setSpeaker(_ on: Bool) throws
    /// Whether the voice goes to the iPhone speaker now.
    var outputIsSpeaker: Bool { get }
    /// Closes the connection and the microphone. Safe to call twice.
    func hangUp()
}

/// What the user sees and hears of the session: the Live Activity and the start sound.
@MainActor
protocol SessionFeedback {
    func showSpeaker(_ on: Bool)
    func show(_ state: SessionState)
}

/// Runs a voice conversation from "Parler" to its end: Face ID, the WebRTC call, and the
/// session on the companion.
@MainActor
final class VoiceSessionController: ObservableObject {
    @Published private(set) var state: SessionState = .idle
    /// Why the last session failed, until the next start.
    @Published private(set) var lastFailure: SessionFailure?
    /// The voice goes to the iPhone speaker. Off at the start of each session: an answer about
    /// the code must not play aloud in a room by surprise (decided by Thomas in #19).
    @Published private(set) var speaker = false

    private let client: CompanionClient
    private let authenticator: Authenticator
    private let makeCall: @MainActor () -> VoiceCall
    private let feedback: SessionFeedback
    /// The IANA zone the companion uses for "today".
    private let timeZone: String

    /// The call of the current session, and the session on the companion once it answered.
    private var call: VoiceCall?
    private var session: OpenedSession?

    init(
        client: CompanionClient,
        authenticator: Authenticator,
        makeCall: @escaping @MainActor () -> VoiceCall,
        feedback: SessionFeedback,
        timeZone: String
    ) {
        self.client = client
        self.authenticator = authenticator
        self.makeCall = makeCall
        self.feedback = feedback
        self.timeZone = timeZone
    }

    /// Returns once the call waits for `session.started`, or when the start failed.
    /// Before pairing it does nothing: the app shows the pairing screen.
    func start() async {
        guard state == .idle, client.isPaired else { return }
        lastFailure = nil
        show(.authenticating)
        guard await authenticator.authenticate() else {
            show(.idle)
            return
        }
        show(.connecting)
        let call = makeCall()
        self.call = call
        do {
            let offer = try await call.start { [weak self, weak call] event in
                guard let self, let call else { return }
                await self.handle(event, from: call)
            }
            guard isCurrent(call) else { return }
            let session = try await client.openSession(offer: offer, timeZone: timeZone)
            guard isCurrent(call) else {
                // Ended while the companion opened it: close it there too.
                try? await client.closeSession(session)
                return
            }
            self.session = session
            try await call.accept(answer: session.answer)
        } catch {
            // Once ended, `finish` already closed what it could.
            guard isCurrent(call) else { return }
            await finish(.error(SessionFailure(error)))
        }
    }

    /// The End button, in the app or on the Live Activity.
    func end() async {
        guard state != .idle else {
            // After the app was killed, the End button of its Live Activity starts a new
            // process with no session: clear what the lock screen still shows.
            feedback.show(.idle)
            return
        }
        await finish(.user)
    }

    /// The Speaker button, in the app or on the Live Activity.
    func toggleSpeaker() {
        if state == .idle {
            // Like End: after the app was killed, its Live Activity still shows the microphone.
            feedback.show(.idle)
            return
        }
        guard case .live = state, let call else { return }
        do {
            try call.setSpeaker(!speaker)
        } catch {
            return
        }
        showSpeaker(!speaker)
    }

    private func handle(_ event: VoiceCallEvent, from call: VoiceCall) async {
        guard call === self.call else { return }
        switch event {
        case .sessionStarted:
            if state == .connecting { show(.live) }
        case .sessionClosed:
            await finish(.voice)
        case .routeChanged:
            // The event can arrive after a tap turned the speaker on again, so read the route
            // now. A route change only ever turns the speaker off (spec #15, "Audio").
            if !call.outputIsSpeaker { showSpeaker(false) }
        case .lost:
            await finish(.error(.lost))
        }
    }

    /// Closes the microphone at once, then the session on the companion if it has one.
    /// While the companion is still opening it, `start()` closes it when its answer arrives.
    private func finish(_ reason: EndReason) async {
        guard state == .connecting || state == .live else { return }
        if case let .error(failure) = reason { lastFailure = failure }
        show(.ending(reason))
        call?.hangUp()
        call = nil
        showSpeaker(false)
        let session = self.session
        self.session = nil
        // After `session.closed` the companion has nothing left to close.
        if let session, reason != .voice { try? await client.closeSession(session) }
        show(.idle)
    }

    private func isCurrent(_ call: VoiceCall) -> Bool {
        call === self.call && state == .connecting
    }

    private func showSpeaker(_ on: Bool) {
        guard speaker != on else { return }
        speaker = on
        feedback.showSpeaker(on)
    }

    private func show(_ state: SessionState) {
        self.state = state
        feedback.show(state)
    }
}
