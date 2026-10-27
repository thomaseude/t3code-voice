import SwiftUI
import WidgetKit

@main
struct T3VoiceWidgetBundle: WidgetBundle {
    var body: some Widget {
        VoiceLiveActivity()
        StartSessionControl()
    }
}
