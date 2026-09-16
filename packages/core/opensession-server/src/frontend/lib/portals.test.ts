import { describe, expect, test } from "bun:test";
import {
  defaultSidebarPortalFor,
  portalOpenPlacement,
  portalTargetFor,
} from "./portals";

describe("portalTargetFor", () => {
  test("opens running and auto-wake sleeping services with an authenticated URL", () => {
    expect(
      portalTargetFor("session-1", {
        name: "Webapp",
        key: "WEBAPP_PORT",
        port: 3300,
        running: true,
        pids: [],
        previewUrl: "https://os.example.test:23000",
      }),
    ).toEqual({
      sessionId: "session-1",
      name: "Webapp",
      key: "WEBAPP_PORT",
      port: 3300,
      url: "https://os.example.test:23000",
    });
  });

  test("keeps stopped and unpublished services out of the browser", () => {
    const service = {
      name: "Temporal UI",
      key: "TEMPORAL_UI_PORT",
      port: 8312,
      pids: [],
    };
    expect(
      portalTargetFor("session-1", { ...service, running: false }),
    ).toBeNull();
    expect(
      portalTargetFor("session-1", {
        ...service,
        running: false,
        state: "sleeping",
        previewUrl: "https://os.example.test:23000",
        defaultPath: "/temporal",
      }),
    ).toMatchObject({ url: "https://os.example.test:23000/temporal" });
    expect(
      portalTargetFor("session-1", {
        ...service,
        running: true,
        previewUrl: null,
      }),
    ).toBeNull();
  });
});

describe("portalOpenPlacement", () => {
  const target = {
    sessionId: "session-1",
    name: "ios-simulator-a1b2c3d4e5f6",
    key: "IOS_SIMULATOR_1_PORT",
    port: 8100,
    url: "https://os.example.test:23000",
  };

  test("opens an iOS Simulator Portal in the desktop sidebar", () => {
    expect(portalOpenPlacement(target, false)).toBe("sidebar");
  });

  test("keeps the iOS Simulator Portal full-width on phones", () => {
    expect(portalOpenPlacement(target, true)).toBe("main");
  });

  test("keeps generic portals in the main pane", () => {
    expect(portalOpenPlacement({ ...target, name: "Storybook" }, false)).toBe(
      "main",
    );
  });

  test("requires the generated 12-character simulator id", () => {
    expect(
      portalOpenPlacement({ ...target, name: "ios-simulator-a1b2c3" }, false),
    ).toBe("main");
  });

  test("accepts the current session's routed simulator entrypoint", () => {
    expect(defaultSidebarPortalFor("session-1", [], target, false)).toBe(
      target,
    );
    expect(defaultSidebarPortalFor("session-2", [], target, false)).toBeNull();
  });

  test("finds a simulator newly discovered in the current session", () => {
    expect(
      defaultSidebarPortalFor(
        "session-1",
        [
          {
            name: target.name,
            key: target.key,
            port: target.port,
            running: true,
            pids: [],
            previewUrl: target.url,
          },
        ],
        null,
        false,
      ),
    ).toEqual(target);
  });
});
