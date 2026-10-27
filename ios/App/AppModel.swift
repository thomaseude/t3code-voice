import Foundation
import UIKit

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

    private let store: ConnectionStore
    private let client: CompanionClient

    init(store: ConnectionStore = KeychainConnectionStore(), transport: HTTPTransport = URLSessionTransport()) {
        self.store = store
        client = CompanionClient(transport: transport, store: store)
        isPaired = (try? store.load()) != nil
    }

    /// Called with the text of each QR code the camera reads.
    func scanned(_ text: String) {
        guard pairingStatus != .pairing else { return }
        guard let link = PairingLink(text) else {
            pairingStatus = .failed("Ce QR code n'est pas un code d'appairage T3 Voice.")
            return
        }
        pairingStatus = .pairing
        Task {
            do {
                switch try await client.pair(with: link, deviceName: UIDevice.current.name) {
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
    }

    func refreshActivity() async {
        do {
            activityStatus = .loaded(try await client.activity())
        } catch CompanionError.unauthorized {
            // Revoked or reset: the stored token is useless, so pair again.
            forget()
        } catch CompanionError.t3Unavailable {
            activityStatus = .failed("Le companion se reconnecte à T3. Réessaie dans un instant.")
        } catch let CompanionError.limited(seconds) {
            activityStatus = .failed("Trop de requêtes. Réessaie dans \(minutes(seconds)).")
        } catch {
            activityStatus = .failed("Le companion ne répond pas.")
        }
    }

    /// Deletes the connection on this iPhone only. To revoke the device on the server,
    /// run `t3-voice devices revoke` there.
    func forget() {
        try? store.delete()
        isPaired = false
        pairingStatus = .scanning
        activityStatus = .loading
    }

    func retryScanning() {
        pairingStatus = .scanning
    }

    private func minutes(_ seconds: Int?) -> String {
        guard let seconds else { return "quelques minutes" }
        let minutes = max(1, (seconds + 59) / 60)
        return minutes == 1 ? "1 minute" : "\(minutes) minutes"
    }
}
