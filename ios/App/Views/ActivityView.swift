import SwiftUI

/// Once paired: what T3 runs now and what finished in the last 24 hours, and the button that
/// starts a voice conversation.
struct ActivityView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var session: VoiceSessionController
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Activité")
                .safeAreaInset(edge: .bottom) { voice }
                .refreshable { await model.refreshActivity() }
                .task { await model.refreshActivity() }
                .toolbar {
                    Button("Oublier", role: .destructive) { confirmForget = true }
                }
                .confirmationDialog(
                    "Oublier ce companion ?",
                    isPresented: $confirmForget,
                    titleVisibility: .visible
                ) {
                    Button("Oublier", role: .destructive) { Task { await model.forget() } }
                } message: {
                    Text("Le jeton est effacé de cet iPhone. Pour le révoquer sur le serveur, lance « t3-voice devices revoke ».")
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.activityStatus {
        case .loading:
            ProgressView()
        case let .failed(message):
            ContentUnavailableView {
                Label("Activité indisponible", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Réessayer") { Task { await model.refreshActivity() } }
            }
        case let .loaded(activity):
            List {
                Section("En cours") { rows(activity.running, empty: "Aucune tâche en cours.") }
                Section("Terminé (24 h)") { rows(activity.finished, empty: "Rien de terminé ces dernières 24 h.") }
            }
        }
    }

    private var voice: some View {
        VStack(spacing: 8) {
            if let failure = session.lastFailure {
                Text(failure.message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            switch session.state {
            case .idle:
                Button {
                    Task { await session.start() }
                } label: {
                    Label("Parler", systemImage: "mic.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            case .authenticating:
                ProgressView()
            case .connecting, .live:
                HStack {
                    Label(session.state.label ?? "", systemImage: "mic.fill")
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Fin", role: .destructive) { Task { await session.end() } }
                        .buttonStyle(.borderedProminent)
                }
            case .ending:
                Text(session.state.label ?? "").foregroundStyle(.secondary)
            }
        }
        .controlSize(.large)
        .padding()
        .background(.bar)
    }

    @ViewBuilder
    private func rows(_ items: [ActivityItem], empty: String) -> some View {
        if items.isEmpty {
            Text(empty).foregroundStyle(.secondary)
        } else {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                    HStack {
                        Text(ActivityItem.label(for: item.state))
                        if let project = item.project { Text("· \(project)") }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }
}
