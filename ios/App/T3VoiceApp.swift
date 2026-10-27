import SwiftUI
import UIKit

@main
struct T3VoiceApp: App {
    @StateObject private var model = AppModel(
        store: KeychainConnectionStore(),
        transport: URLSessionTransport(),
        modelName: UIDevice.current.model
    )

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
        }
    }
}
