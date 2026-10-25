import Foundation
import UIKit

/// Timestamped log shown in the app and appended to a file you can export after the test.
/// Each line carries the app state (FG/BG/IN) and whether the device is locked.
@MainActor
final class EventLog: ObservableObject {
    static let shared = EventLog()

    @Published private(set) var lines: [String] = []
    let fileURL: URL
    private let formatter = DateFormatter()

    private init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        fileURL = documents.appendingPathComponent("proto-log-\(stamp).txt")
        FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        formatter.dateFormat = "HH:mm:ss.SSS"
    }

    func log(_ message: String) {
        let app = UIApplication.shared
        var state = "??"
        switch app.applicationState {
        case .active: state = "FG"
        case .inactive: state = "IN"
        case .background: state = "BG"
        @unknown default: break
        }
        let locked = app.isProtectedDataAvailable ? "" : "/locked"
        let line = "\(formatter.string(from: Date())) [\(state)\(locked)] \(message)"
        lines.append(line)
        if lines.count > 500 { lines.removeFirst(lines.count - 500) }
        if let handle = try? FileHandle(forWritingTo: fileURL) {
            handle.seekToEndOfFile()
            handle.write(Data((line + "\n").utf8))
            try? handle.close()
        }
        print(line)
    }
}
