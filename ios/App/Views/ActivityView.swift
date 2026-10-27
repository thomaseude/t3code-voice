import SwiftUI

/// Once paired: what T3 runs now and what finished in the last 24 hours.
struct ActivityView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Activité")
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
                    Button("Oublier", role: .destructive) { model.forget() }
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
                Section("Terminé (24 h)") { rows(activity.finished, empty: "Rien de terminé aujourd'hui.") }
            }
        }
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
                        Text(Self.label(for: item.state))
                        if let project = item.project { Text("· \(project)") }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// T3's state names, in French. An unknown state from a newer T3 is shown as is.
    static func label(for state: String) -> String {
        switch state {
        case "running": "en cours"
        case "waiting_for_input": "attend ta réponse"
        case "waiting_for_approval": "demande une autorisation"
        case "completed": "terminée"
        case "failed": "échouée"
        default: state
        }
    }
}
