// Which route changes mute the session: only a headset that went away.

import AVFoundation
import XCTest
@testable import T3Voice

final class AudioRouteTests: XCTestCase {
    func testAirPodsTakenOutCountAsAHeadsetLost() {
        XCTAssertTrue(AudioRoute.headsetLost(reason: .oldDeviceUnavailable, previousOutputs: [.bluetoothHFP]))
        XCTAssertTrue(AudioRoute.headsetLost(reason: .oldDeviceUnavailable, previousOutputs: [.bluetoothA2DP]))
        XCTAssertTrue(AudioRoute.headsetLost(reason: .oldDeviceUnavailable, previousOutputs: [.headphones]))
    }

    func testANewDeviceIsNotALoss() {
        XCTAssertFalse(AudioRoute.headsetLost(reason: .newDeviceAvailable, previousOutputs: [.builtInReceiver]))
        XCTAssertFalse(AudioRoute.headsetLost(reason: .categoryChange, previousOutputs: [.bluetoothHFP]))
    }

    func testLosingAnotherOutputIsNotAHeadsetLost() {
        // Only a headset counts: losing car audio does not mute the session.
        XCTAssertFalse(AudioRoute.headsetLost(reason: .oldDeviceUnavailable, previousOutputs: [.carAudio]))
        XCTAssertFalse(AudioRoute.headsetLost(reason: nil, previousOutputs: [.bluetoothHFP]))
    }
}
