import Foundation

/// Per-user visibility for the TOOLS: the destinations that are not sessions.
/// The web sidebar owns the ids; this app draws Feed, Tasks, Catch up, Reports
/// and Support.
///
/// This is the same account-level preference the web's Tools band writes
/// (`sidebar-hidden-tools`, see `src/frontend/lib/sidebar-tools.ts`), so a tool
/// switched off in the browser is off here too. Before that pref existed the
/// web kept this in one browser's local storage and the phone could not see
/// it, which is how Reports came to sit on the phone for people whose sidebar
/// had never offered it.
///
/// The value is a JSON array of hidden tool ids, kept whole on every write: an
/// id this build never renders still belongs to the account, and dropping it
/// would silently restore a tool the person hid in the browser.
enum SidebarTools {
    /// The tools this app has a destination for. They are named here
    /// because the surfaces are built in Swift; the ids are the web's.
    static let feed = "feed"
    static let prs = "prs"
    static let tasks = "tasks"
    static let plain = "plain"
    static let catchUp = "catchup"
    static let reports = "reports"

    /// What an account shows when nobody has chosen. Support Tinder and
    /// Analytics have no phone surface here, but the whole list is mirrored
    /// because it is the agreement with the web: absent means exactly this, on
    /// both clients. Keep it in step with DEFAULT_VISIBLE_TOOLS in
    /// packages/core/opensession-server/src/frontend/lib/sidebar-tools.ts.
    static let allIds = [
        feed, prs, "issues", tasks, plain, catchUp, "supporttinder", reports,
        "analytics",
    ]
    static let defaultVisible = [feed, prs, plain, catchUp]
    static var defaultHidden: [String] { allIds.filter { !defaultVisible.contains($0) } }
    static var defaultHiddenJSON: String { encode(defaultHidden) }

    /// One switch in Settings → Appearance. Support is intentionally absent:
    /// its tool and feed are one three-way location choice (`SupportLocation`).
    struct Tool: Identifiable, Hashable, Sendable {
        let id: String
        let title: String
    }

    static let surfaced: [Tool] = [
        Tool(id: feed, title: "Feed"),
        Tool(id: tasks, title: "Tasks"),
        Tool(id: catchUp, title: "Catch up"),
        Tool(id: reports, title: "Reports"),
    ]

    /// Mirrors the server pref into `@AppStorage`, like every other
    /// cross-device preference (`NativePreferences`).
    static let storageKey = "os1.sidebar.hiddenTools"
    static let prefKey = "sidebar-hidden-tools"

    /// Hidden tool ids as stored, or nil when the value is not a list.
    ///
    /// Nil is not "nothing hidden" here, which is the one place this differs
    /// from `SidebarFeeds`: an empty list is a choice ("show everything") and
    /// a missing one is not, so they cannot collapse to the same answer
    /// without handing back the four tools a new account starts without.
    static func decode(_ json: String) -> [String]? {
        guard let data = json.data(using: .utf8),
              let ids = try? JSONDecoder().decode([String].self, from: data)
        else { return nil }
        var seen = Set<String>()
        return ids.compactMap { id in
            let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
    }

    /// What is hidden, with the shared defaults standing in for a value that
    /// was never set or cannot be read.
    static func hidden(in json: String) -> [String] {
        decode(json) ?? defaultHidden
    }

    static func encode(_ ids: [String]) -> String {
        guard let data = try? JSONEncoder().encode(ids) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    static func isHidden(_ id: String, in json: String) -> Bool {
        hidden(in: json).contains(id)
    }

    /// The list with one id set either way, every other id left exactly where
    /// it was. Returns the input unchanged when nothing moves, so a caller can
    /// use that to skip a needless write.
    static func setting(_ id: String, hidden setHidden: Bool, in json: String) -> String {
        var ids = hidden(in: json)
        if setHidden {
            guard !ids.contains(id) else { return encode(ids) }
            ids.append(id)
        } else {
            guard ids.contains(id) else { return encode(ids) }
            ids.removeAll { $0 == id }
        }
        return encode(ids)
    }
}

@MainActor
extension SidebarTools {
    static func isHidden(_ id: String) -> Bool {
        isHidden(id, in: UserDefaults.standard.string(forKey: storageKey) ?? defaultHiddenJSON)
    }

    /// Write the local copy the views read through `@AppStorage`, then push the
    /// same value to the account. Fire-and-forget like the web's own save and
    /// like `SidebarFeeds`: this is a preference, not work, so a failed PUT
    /// costs a second tap rather than an error banner.
    static func setVisible(_ id: String, _ visible: Bool) {
        let defaults = UserDefaults.standard
        let current = defaults.string(forKey: storageKey) ?? defaultHiddenJSON
        let next = setting(id, hidden: !visible, in: current)
        guard next != current else { return }
        defaults.set(next, forKey: storageKey)
        let user = ServerConfig.shared.userName
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(user: user, prefs: [prefKey: next])
        }
    }
}
