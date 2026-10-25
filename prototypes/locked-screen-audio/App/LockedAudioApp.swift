import SwiftUI

@main
struct LockedAudioApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(VoiceSession.shared)
                .environmentObject(EventLog.shared)
        }
    }
}
