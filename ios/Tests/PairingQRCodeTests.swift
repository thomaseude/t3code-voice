// The QR code `t3-voice pair` shows: t3voice://pair?url=<companion https URL>&code=<one-time code>.

import XCTest
@testable import T3Voice

final class PairingQRCodeTests: XCTestCase {
    func testReadsTheCompanionAddressAndTheCode() {
        // As the companion builds it: URLSearchParams escapes the URL.
        let qrCode = PairingQRCode("t3voice://pair?url=https%3A%2F%2Fvoice.example.com&code=kq3V8o2Yc1rJm0bT6wXpZf")

        XCTAssertEqual(qrCode?.companionURL, URL(string: "https://voice.example.com"))
        XCTAssertEqual(qrCode?.code, "kq3V8o2Yc1rJm0bT6wXpZf")
    }

    func testRefusesAnAddressThatIsNotHTTPS() {
        // The device token would travel in clear.
        XCTAssertNil(PairingQRCode("t3voice://pair?url=http%3A%2F%2Fvoice.example.com&code=abc"))
    }

    func testRefusesOtherQRCodes() {
        for text in [
            "https://voice.example.com",
            "t3voice://session?item=1",
            "t3voice://pair?url=https%3A%2F%2Fvoice.example.com",
            "t3voice://pair?url=https%3A%2F%2Fvoice.example.com&code=",
            "t3voice://pair?code=abc",
            "not a link",
        ] {
            XCTAssertNil(PairingQRCode(text), text)
        }
    }
}
