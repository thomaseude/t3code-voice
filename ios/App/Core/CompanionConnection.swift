import Foundation

/// How the app reaches its companion: an address and this device's token. A future cloud
/// login can give the same two things. The token is a secret: never log or show it.
struct CompanionConnection: Codable, Equatable {
    var companionURL: URL
    var token: String
    /// The token this one replaced, kept to close a voice session opened with it. Nil until
    /// the first rotation, and in connections stored before it existed.
    var replacedToken: String?
}

/// Where the connection is kept between launches.
protocol ConnectionStore {
    func load() throws -> CompanionConnection?
    func save(_ connection: CompanionConnection) throws
    func delete() throws
}
