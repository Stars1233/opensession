import Foundation

/// A URL on the app's own scheme, registered in project.yml for the iOS
/// target. The Home Screen tile the server hands out (Settings > General) is
/// aimed at the bare `os1://`; `os1://session/<id>` mirrors the desktop
/// shell's links and opens that session.
enum AppDeepLink: Equatable {
    static let scheme = "os1"

    case open
    case session(id: String)

    /// nil for anything that is not on the scheme, such as a file handed to
    /// the app by Files, which shares the `onOpenURL` delivery.
    static func parse(_ url: URL) -> AppDeepLink? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        // `os1://session/abc` parses with `session` as the host.
        let parts = ([url.host ?? ""] + url.pathComponents)
            .filter { !$0.isEmpty && $0 != "/" }
        if parts.first == "session", parts.count >= 2 { return .session(id: parts[1]) }
        return .open
    }
}
