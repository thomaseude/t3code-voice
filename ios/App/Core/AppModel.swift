import Foundation

/// What the screens show: paired or not, the pairing in progress, the activity list.
@MainActor
final class AppModel: ObservableObject {
    enum PairingStatus: Equatable {
        case scanning
        case pairing
        case failed(String)
    }

    enum ActivityStatus: Equatable {
        case loading
        case loaded(Activity)
        case failed(String)
    }

    @Published private(set) var isPaired: Bool
    @Published private(set) var pairingStatus: PairingStatus = .scanning
    @Published private(set) var activityStatus: ActivityStatus = .loading
    /// The name `t3-voice devices list` shows for this iPhone. iOS gives apps only the model
    /// name ("iPhone"), so the user can type a better one before scanning.
    @Published var deviceName: String
    /// Changes on each retry: the screen then restarts the camera, which reports a QR code
    /// only when it first sees it.
    @Published private(set) var scanAttempt = 0

    private let store: ConnectionStore
    private let client: CompanionClient
    /// The name iOS gives the device ("iPhone"), used when the field is left empty.
    private let modelName: String
    /// Ends the voice conversation, if one runs.
    private let endSession: @MainActor () async -> Void
    /// Goes up on each "Oublier": a refresh drops its answer if it went up meanwhile.
    private var forgottenCount = 0

    init(
        store: ConnectionStore,
        transport: HTTPTransport,
        modelName: String,
        endSession: @escaping @MainActor () async -> Void = {}
    ) {
        self.store = store
        client = CompanionClient(transport: transport, store: store)
        self.modelName = modelName
        self.endSession = endSession
        deviceName = modelName
        isPaired = (try? store.load()) != nil
    }

    /// Called with the text of each QR code the camera reads.
    func scanned(_ text: String) async {
        guard pairingStatus == .scanning else { return }
        guard let qrCode = PairingQRCode(text) else {
            pairingStatus = .failed("Ce QR code n'est pas un code d'appairage T3 Voice.")
            return
        }
        pairingStatus = .pairing
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            switch try await client.pair(with: qrCode, deviceName: name.isEmpty ? modelName : name) {
            case .paired:
                pairingStatus = .scanning
                isPaired = true
            case .refused:
                pairingStatus = .failed("Code refusé : il a déjà servi ou a expiré. Relance « t3-voice pair ».")
            case let .limited(seconds):
                pairingStatus = .failed("Trop d'essais. Réessaie dans \(minutes(seconds)).")
            }
        } catch {
            pairingStatus = .failed("Le companion ne répond pas. Vérifie son adresse et ta connexion.")
        }
    }

    func refreshActivity() async {
        let forgottenCountAtStart = forgottenCount
        let result: Result<Activity, Error>
        do {
            result = .success(try await client.activity())
        } catch {
            result = .failure(error)
        }
        // "Oublier" ran while the request was out, and another companion may be paired now.
        guard forgottenCountAtStart == forgottenCount else { return }
        switch result {
        case let .success(activity):
            activityStatus = .loaded(activity)
        case let .failure(error):
            switch error as? CompanionError {
            case .unauthorized?, .notPaired?:
                // Revoked, reset, or the stored token is gone: nothing can reach the companion.
                await forget()
            case .t3Unavailable?:
                activityStatus = .failed("Le companion se reconnecte à T3. Réessaie dans un instant.")
            case let .limited(seconds)?:
                activityStatus = .failed("Trop de requêtes. Réessaie dans \(minutes(seconds)).")
            default:
                activityStatus = .failed("Le companion ne répond pas.")
            }
        }
    }

    /// Deletes the connection on this iPhone only (kept by Thomas in PR #33). To revoke the
    /// device on the server, run `t3-voice devices revoke` there. A running voice conversation
    /// ends first, while its `DELETE` can still send the token.
    func forget() async {
        forgottenCount += 1
        await endSession()
        try? store.delete()
        isPaired = false
        pairingStatus = .scanning
        activityStatus = .loading
    }

    func retryScanning() {
        pairingStatus = .scanning
        scanAttempt += 1
    }

    private func minutes(_ seconds: Int?) -> String {
        guard let seconds else { return "quelques minutes" }
        let minutes = max(1, (seconds + 59) / 60)
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }
}
