import AVFoundation
import SwiftUI
import VisionKit

/// First launch: scan the QR code that `t3-voice pair` shows on the server.
struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                TextField("Nom de cet iPhone", text: $model.deviceName)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal)

                Text("Sur le serveur, lance « t3-voice pair », puis scanne le QR code affiché.")
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                scanner
                status
                Spacer()
            }
            .padding(.top)
            .navigationTitle("Appairer T3 Voice")
            .task {
                if camera == .notDetermined {
                    _ = await AVCaptureDevice.requestAccess(for: .video)
                    camera = AVCaptureDevice.authorizationStatus(for: .video)
                }
            }
        }
    }

    @ViewBuilder
    private var scanner: some View {
        if !DataScannerViewController.isSupported {
            Text("Cet appareil ne peut pas scanner de QR code.")
                .foregroundStyle(.secondary)
        } else if camera == .authorized {
            QRScannerView { text in Task { await model.scanned(text) } }
                // A new view on each retry: the camera reports a code only when it first sees it.
                .id(model.scanAttempt)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .frame(maxHeight: 360)
                .padding(.horizontal)
        } else if camera == .notDetermined {
            ProgressView()
        } else {
            VStack(spacing: 8) {
                Text("T3 Voice a besoin de la caméra pour scanner le QR code.")
                    .multilineTextAlignment(.center)
                Button("Ouvrir les Réglages") {
                    if let settings = URL(string: UIApplication.openSettingsURLString) { openURL(settings) }
                }
            }
            .padding(.horizontal)
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

/// The camera, reading QR codes. Each code is passed to `onScan` when the camera first sees it.
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
