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
        // A car's or a TV's audio leaving does not put the phone's microphone near strangers' ears.
        XCTAssertFalse(AudioRoute.headsetLost(reason: .oldDeviceUnavailable, previousOutputs: [.carAudio]))
        XCTAssertFalse(AudioRoute.headsetLost(reason: nil, previousOutputs: [.bluetoothHFP]))
    }
}
