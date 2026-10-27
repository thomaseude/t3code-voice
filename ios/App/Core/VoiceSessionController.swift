import Foundation

/// Where a voice conversation is, from the user's point of view (spec #15, "Session state
/// machine"). Interruption, reconnection and suspension come with #26.
enum SessionState: Equatable {
    case idle
    /// Face ID is on screen.
    case authenticating
    /// The microphone is open and the companion opens the session with the voice engine.
    case connecting
    /// Muted: the microphone sends nothing, and the assistant still speaks.
    case live(muted: Bool)
    case ending(EndReason)

    /// What the screen and the Live Activity say about the session. Nil when no session runs.
    var label: String? {
        switch self {
        case .idle, .authenticating: nil
        case .connecting: "Connexion…"
        case .live(muted: false): "À l'écoute"
        case .live(muted: true): "En sourdine"
        case .ending: "Fin…"
        }
    }

    var isLive: Bool {
        if case .live = self { return true }
        return false
    }
}

enum EndReason: Equatable {
    /// The End button, in the app or on the Live Activity.
    case user
    /// `session.closed` arrived: the companion closed it. Most often the voice model ended it
    /// ("fin", "c'est bon, merci"), but the companion also closes it after a silence, at the
    /// daily budget, when the device is revoked, when `serve` stops, or when a newer session
    /// replaces it. The phone cannot tell these apart: the assistant says why first.
    case voice
    case error(SessionFailure)
}

enum SessionFailure: Equatable {
    case microphoneDenied
    case unauthorized
    case limited
    case voiceUnavailable
    case voiceEngineFailed
    /// Today's sessions cost the companion's daily budget.
    case budgetReached
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
        case .budgetReached: "Le budget voix du jour est atteint. Réessaie demain."
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
        case CompanionError.budgetReached: self = .budgetReached
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

/// What the voice engine and the audio route report on the call.
enum VoiceCallEvent: Equatable {
    /// `session.started` on the data channel: the phone may talk.
    case sessionStarted
    /// `session.closed` on the data channel: the session ended on the voice engine's side.
    case sessionClosed
    /// The peer connection or the data channel failed.
    case lost
    /// The AirPods (or another headset) went away: iOS would go on with the phone's own mic.
    case headsetLost
    /// The user pressed the AirPods stem: iOS asks to mute or unmute.
    case headsetMuteChanged(muted: Bool)
}

/// One WebRTC call to the voice engine, with the audio session. A new one for each session.
@MainActor
protocol VoiceCall: AnyObject {
    /// Opens the microphone and returns the SDP offer, without waiting for full ICE gathering.
    func start(onEvent: @escaping @MainActor (VoiceCallEvent) async -> Void) async throws -> String
    func accept(answer: String) async throws
    /// Closes the connection and the microphone. Safe to call twice.
    func hangUp()
    /// Sends silence instead of the microphone, or the microphone again.
    func setMuted(_ muted: Bool)
}

/// What the user sees and hears of the session: the Live Activity and the start sound.
@MainActor
protocol SessionFeedback {
    func show(_ state: SessionState)
}

/// Runs a voice conversation from "Parler" to its end: Face ID, the WebRTC call, and the
/// session on the companion.
@MainActor
final class VoiceSessionController: ObservableObject {
    @Published private(set) var state: SessionState = .idle
    /// Why the last session failed, until the next start.
    @Published private(set) var lastFailure: SessionFailure?

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

    /// The Mute/Unmute button, in the app or on the Live Activity.
    func toggleMute() async {
        guard case let .live(muted) = state else { return }
        await setMuted(!muted)
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

    private func handle(_ event: VoiceCallEvent, from call: VoiceCall) async {
        guard call === self.call else { return }
        switch event {
        case .sessionStarted:
            if state == .connecting { show(.live(muted: false)) }
        case .sessionClosed:
            await finish(.voice)
        case .lost:
            await finish(.error(.lost))
        case .headsetLost:
            // Muted rather than going on with the phone's own microphone (spec #15, "Audio").
            await setMuted(true)
        case let .headsetMuteChanged(muted):
            await setMuted(muted)
        }
    }

    /// Mutes or unmutes the microphone at once. The companion is told so it counts muted
    /// time as silence; a failed request leaves the microphone as the user asked.
    private func setMuted(_ muted: Bool) async {
        guard case let .live(current) = state, current != muted, let call else { return }
        call.setMuted(muted)
        show(.live(muted: muted))
        guard let session else { return }
        try? await client.send(muted ? .mute : .unmute, in: session)
    }

    /// Closes the microphone at once, then the session on the companion if it has one.
    /// While the companion is still opening it, `start()` closes it when its answer arrives.
    private func finish(_ reason: EndReason) async {
        guard state == .connecting || state.isLive else { return }
        if case let .error(failure) = reason { lastFailure = failure }
        show(.ending(reason))
        call?.hangUp()
        call = nil
        let session = self.session
        self.session = nil
        // After `session.closed` the companion has nothing left to close.
        if let session, reason != .voice { try? await client.closeSession(session) }
        show(.idle)
    }

    private func isCurrent(_ call: VoiceCall) -> Bool {
        call === self.call && state == .connecting
    }

    private func show(_ state: SessionState) {
        self.state = state
        feedback.show(state)
    }
}
