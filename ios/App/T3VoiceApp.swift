import SwiftUI

@main
struct T3VoiceApp: App {
    @StateObject private var model = AppModel()

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
