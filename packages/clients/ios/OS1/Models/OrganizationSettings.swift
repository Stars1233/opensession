import Foundation

/// Settings → General: the company or team sharing this server.
struct OrganizationSettings: Codable, Sendable, Equatable {
    var organizationName: String?
    var organizationIconUrl: String?
    var organizationIconRevision: String?
    /// An iOS configuration profile that puts the icon on the Home Screen.
    var homeScreenProfileUrl: String?
    var configPath: String?
}
