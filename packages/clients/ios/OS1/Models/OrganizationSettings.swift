import Foundation

/// Settings → General: the company or team sharing this server.
struct OrganizationSettings: Codable, Sendable, Equatable {
    var organizationName: String?
    var organizationIconUrl: String?
    var organizationIconRevision: String?
    var configPath: String?
}
