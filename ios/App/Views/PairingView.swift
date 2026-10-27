import SwiftUI
import VisionKit

/// First launch: scan the QR code that `t3-voice pair` shows on the server.
struct PairingView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("Sur le serveur, lance « t3-voice pair », puis scanne le QR code affiché.")
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                if DataScannerViewController.isSupported {
                    QRScannerView { text in model.scanned(text) }
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .frame(maxHeight: 360)
                        .padding(.horizontal)
                } else {
                    Text("Cet appareil ne peut pas scanner de QR code.")
                        .foregroundStyle(.secondary)
                }

                status
                Spacer()
            }
            .padding(.top)
            .navigationTitle("Appairer T3 Voice")
        }
    }

    @ViewBuilder
    private var status: some View {
        switch model.pairingStatus {
        case .scanning:
            EmptyView()
        case .pairing:
            ProgressView("Appairage…")
        case let .failed(message):
            VStack(spacing: 8) {
                Text(message)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                Button("Scanner à nouveau") { model.retryScanning() }
            }
            .padding(.horizontal)
        }
    }
}

/// The camera, reading QR codes. Each code read is passed to `onScan` once.
struct QRScannerView: UIViewControllerRepresentable {
    let onScan: @MainActor (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: @MainActor (String) -> Void

        init(onScan: @escaping @MainActor (String) -> Void) {
            self.onScan = onScan
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case let .barcode(barcode) = item, let text = barcode.payloadStringValue {
                    onScan(text)
                }
            }
        }
    }
}
