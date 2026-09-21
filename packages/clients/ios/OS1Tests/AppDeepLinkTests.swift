import XCTest
@testable import OS1

final class AppDeepLinkTests: XCTestCase {
    func testBareSchemeOpensTheApp() {
        XCTAssertEqual(AppDeepLink.parse(URL(string: "os1://")!), .open)
        XCTAssertEqual(AppDeepLink.parse(URL(string: "OS1://")!), .open)
    }

    func testSessionLinkCarriesTheId() {
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "os1://session/os-123")!),
            .session(id: "os-123")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "os1://session/os-123?x=1#frag")!),
            .session(id: "os-123")
        )
    }

    func testUnknownRoutesStillOpenTheApp() {
        XCTAssertEqual(AppDeepLink.parse(URL(string: "os1://session")!), .open)
        XCTAssertEqual(AppDeepLink.parse(URL(string: "os1://workspace/w1")!), .open)
    }

    func testOtherSchemesAreNotDeepLinks() {
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://example.test/session/os-1")!))
        XCTAssertNil(AppDeepLink.parse(URL(fileURLWithPath: "/tmp/notes.txt")))
    }
}
