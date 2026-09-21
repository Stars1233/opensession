import { describe, expect, test } from "bun:test";
import { describePortalSandbox } from "./portal-sandbox";
import type { UnifiedSession } from "./types";

type PortalSession = Parameters<typeof describePortalSandbox>[0];

function hostSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    id: "os-portal-sandbox-report",
    source: "opensession",
    mode: "code",
    repo: "acme",
    branch: "feature",
    worktreeDir: "/tmp/acme-feature",
    ...overrides,
  } as PortalSession;
}

describe("describePortalSandbox", () => {
  test("a recorded Portal Sandbox reports its lifecycle and the last error", () => {
    expect(
      describePortalSandbox(
        hostSession({
          portalSandbox: {
            provider: "box",
            lifecycle: "needs_attention",
            lastLifecycleError: "box API POST /sandboxes timed out after 60s",
          },
        }),
      ),
    ).toEqual({
      where: "portal",
      provider: "box",
      lifecycle: "needs_attention",
      materialized: false,
      error: "box API POST /sandboxes timed out after 60s",
      busy: false,
    });
  });

  test("a machine recorded without a lifecycle is asleep; a record without a machine is preparing", () => {
    expect(
      describePortalSandbox(
        hostSession({
          portalSandbox: { provider: "box", sandboxId: "bx_1" },
        }),
      ),
    ).toMatchObject({ lifecycle: "sleeping", materialized: true });
    expect(
      describePortalSandbox(
        hostSession({ portalSandbox: { provider: "box" } }),
      ),
    ).toMatchObject({ lifecycle: "preparing", materialized: false });
  });

  test("a workspace Sandbox reports on the session's own record", () => {
    expect(
      describePortalSandbox(
        hostSession({
          sandbox: {
            provider: "daytona",
            sandboxId: "dt_1",
            lifecycle: "sleeping",
          } as UnifiedSession["sandbox"],
          portalSandbox: { provider: "box", sandboxId: "bx_stale" },
        }),
      ),
    ).toEqual({
      where: "workspace",
      provider: "daytona",
      lifecycle: "sleeping",
      busy: false,
    });
  });

  test("a project whose Portals run here has nothing to report", () => {
    expect(describePortalSandbox(hostSession())).toBeNull();
  });
});
