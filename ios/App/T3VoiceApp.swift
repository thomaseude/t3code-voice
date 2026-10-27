import SwiftUI
import UIKit

/// The one place that builds the real Keychain, network, WebRTC, Face ID and Live Activity.
/// The Live Activity's End button and the start intent (Action Button, Siri, Control Center)
/// reach the session through here.
@MainActor
enum Services {
    static let store = KeychainConnectionStore()
    static let transport = URLSessionTransport()
    static let session = VoiceSessionController(
        client: CompanionClient(transport: transport, store: store),
        authenticator: FaceIDAuthenticator(),
        makeCall: { WebRTCCall() },
        feedback: LiveActivityFeedback(),
        timeZone: TimeZone.current.identifier
    )
}

@main
struct T3VoiceApp: App {
    @StateObject private var model = AppModel(
        store: Services.store,
        transport: Services.transport,
        modelName: UIDevice.current.model,
        endSession: { await Services.session.end() }
    )
    @ObservedObject private var session = Services.session

    var body: some Scene {
        WindowGroup {
            Group {
                if model.isPaired {
                    ActivityView()
                } else {
                    PairingView()
                }
            }
            .environmentObject(model)
            .environmentObject(session)
        }
    }
}
