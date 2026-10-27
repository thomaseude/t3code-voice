import AppIntents
import SwiftUI
import WidgetKit

/// The Control Center control. The Action Button can run it too.
struct StartSessionControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "co.joombo.t3voice.start") {
            ControlWidgetButton(action: StartSessionIntent()) {
                Label("Parler à T3", systemImage: "waveform")
            }
        }
        .displayName("Parler à T3")
        .description("Démarre une conversation vocale avec T3, après Face ID.")
    }
}
