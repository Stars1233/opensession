import XCTest
@testable import OS1

final class SidebarToolsTests: XCTestCase {
    // The whole point of the pref: a value the web wrote decides what this app
    // draws, including for tools it has no screen for.
    func testHiddenIdsAreReadWhicheverClientWroteThem() {
        let stored = #"["reports","analytics"]"#
        XCTAssertTrue(SidebarTools.isHidden(SidebarTools.reports, in: stored))
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.catchUp, in: stored))
    }

    // A tool this build never renders still belongs to the account. Writing
    // must carry it through, or hiding Reports here would restore Analytics in
    // the browser.
    func testWritingKeepsIdsThisAppDoesNotDraw() {
        let next = SidebarTools.setting(
            SidebarTools.reports,
            hidden: true,
            in: #"["analytics","tasks"]"#
        )
        XCTAssertEqual(SidebarTools.decode(next), ["analytics", "tasks", "reports"])
    }

    func testShowingRemovesOnlyThatId() {
        let next = SidebarTools.setting(
            SidebarTools.reports,
            hidden: false,
            in: #"["analytics","reports"]"#
        )
        XCTAssertEqual(SidebarTools.decode(next), ["analytics"])
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.reports, in: next))
    }

    func testSettingWhatIsAlreadySetChangesNothing() {
        let hidden = #"["reports"]"#
        XCTAssertEqual(
            SidebarTools.setting(SidebarTools.reports, hidden: true, in: hidden),
            hidden
        )
        let shown = #"["analytics"]"#
        XCTAssertEqual(
            SidebarTools.setting(SidebarTools.reports, hidden: false, in: shown),
            shown
        )
    }

    // The difference from `SidebarFeeds`. An unreadable or absent value is not
    // "nothing hidden": it means nobody has chosen, and a new account starts
    // with Reports off. Reading it the other way is exactly the bug this pref
    // was added to fix, so it is worth pinning.
    func testAnAbsentValueMeansTheSharedDefaults() {
        for missing in ["", "nonsense", "{}", "null", #"{"reports":true}"#] {
            XCTAssertNil(SidebarTools.decode(missing), missing)
            XCTAssertTrue(
                SidebarTools.isHidden(SidebarTools.reports, in: missing),
                missing
            )
            XCTAssertFalse(
                SidebarTools.isHidden(SidebarTools.catchUp, in: missing),
                missing
            )
        }
    }

    // An empty list IS a choice: someone switched every tool on.
    func testAnEmptyListMeansEverythingIsShown() {
        XCTAssertEqual(SidebarTools.decode("[]"), [])
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.reports, in: "[]"))
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.plain, in: "[]"))
    }

    // Existing account values predate new tools. Their absence from an
    // explicit hidden list means visible; only a missing preference receives
    // the newer shared defaults.
    func testAddingAToolDoesNotRewriteAnExplicitAccountChoice() {
        let stored = #"["reports","analytics"]"#
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.plain, in: stored))
        XCTAssertEqual(
            SidebarTools.setting(SidebarTools.plain, hidden: false, in: stored),
            stored
        )
    }

    // Toggling out of a never-set value has to start from the defaults, or the
    // first tap in Settings would hand back the three tools nobody asked for.
    func testTogglingFromAnAbsentValueStartsAtTheDefaults() {
        let next = SidebarTools.setting(SidebarTools.reports, hidden: false, in: "nonsense")
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.reports, in: next))
        XCTAssertTrue(SidebarTools.isHidden("analytics", in: next))
        XCTAssertTrue(SidebarTools.isHidden("tasks", in: next))
    }

    func testDefaultsMatchTheWebsOwnList() {
        XCTAssertEqual(
            SidebarTools.allIds,
            [
                "feed", "prs", "issues", "tasks", "plain", "catchup", "supporttinder",
                "reports", "analytics",
            ]
        )
        XCTAssertEqual(SidebarTools.defaultVisible, ["feed", "prs", "plain", "catchup"])
        XCTAssertEqual(
            SidebarTools.defaultHidden.sorted(),
            ["analytics", "issues", "reports", "supporttinder", "tasks"]
        )
        XCTAssertFalse(SidebarTools.isHidden(SidebarTools.catchUp, in: SidebarTools.defaultHiddenJSON))
        XCTAssertTrue(SidebarTools.isHidden(SidebarTools.reports, in: SidebarTools.defaultHiddenJSON))
    }

    func testBlanksAndDuplicatesAreDropped() {
        XCTAssertEqual(
            SidebarTools.decode(#"[" reports ","","reports","analytics"]"#),
            ["reports", "analytics"]
        )
    }

    // Every switch in Settings must name a screen this app can actually open.
    func testSurfacedToolsAreOnesThisAppDraws() {
        XCTAssertEqual(
            SidebarTools.surfaced.map(\.id),
            [SidebarTools.feed, SidebarTools.tasks, SidebarTools.catchUp, SidebarTools.reports]
        )
        for tool in SidebarTools.surfaced {
            XCTAssertTrue(SidebarTools.allIds.contains(tool.id), tool.id)
            XCTAssertFalse(tool.title.isEmpty, tool.id)
        }
        XCTAssertTrue(SidebarTools.allIds.contains(SidebarTools.plain))
        XCTAssertTrue(SidebarTools.defaultVisible.contains(SidebarTools.plain))
        XCTAssertFalse(SidebarTools.surfaced.map(\.id).contains(SidebarTools.plain))
    }
}
