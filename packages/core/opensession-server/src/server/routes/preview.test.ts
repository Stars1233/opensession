import { describe, expect, test } from "bun:test";
import {
  recipeCommand,
  unavailableSandboxPreviewStatus,
  withPortalSandbox,
} from "./preview";

const hostSession = {
  id: "os-1",
  source: "opensession" as const,
  sandbox: undefined,
  portalSandbox: undefined,
  runner: undefined,
  repo: "tella",
  mode: "code" as const,
  branch: "feature",
  worktreeDir: "/tmp/wt",
  automationId: undefined,
  automation: undefined,
};
const status = { services: [], portalRecipes: [] };

describe("Portal status for a session whose Portals run in a Portal Sandbox", () => {
  test("a workspace Sandbox session is left alone", () => {
    expect(
      withPortalSandbox(
        {
          ...hostSession,
          sandbox: { provider: "daytona", sandboxId: "sb1" },
          portalSandbox: { provider: "daytona", sandboxId: "p1" },
        },
        status,
        true,
      ),
    ).toEqual(status);
  });

  test("a live Portal Sandbox names the provider only", () => {
    expect(
      withPortalSandbox(
        {
          ...hostSession,
          portalSandbox: {
            provider: "box",
            sandboxId: "p1",
            lifecycle: "awake",
          },
        },
        status,
        true,
      ),
    ).toEqual({
      ...status,
      portalSandbox: { provider: "box", lifecycle: "awake" },
    });
  });

  test("a Portal Sandbox that is not live reports its state and keeps the host recipes", () => {
    const recipes = {
      ...status,
      portalRecipes: [{ id: "app", name: "App", command: "./run" }],
    };
    expect(
      withPortalSandbox(
        { ...hostSession, portalSandbox: { provider: "box", sandboxId: "p1" } },
        recipes,
        false,
      ),
    ).toEqual({
      ...recipes,
      sandboxLifecycle: "sleeping",
      portalSandbox: { provider: "box", lifecycle: "sleeping" },
    });
    expect(
      withPortalSandbox(
        {
          ...hostSession,
          portalSandbox: {
            provider: "box",
            lifecycle: "needs_attention",
            lastLifecycleError: "clone failed",
          },
        },
        recipes,
        false,
      ),
    ).toEqual({
      ...recipes,
      sandboxLifecycle: "needs_attention",
      portalSandbox: {
        provider: "box",
        lifecycle: "needs_attention",
        error: "clone failed",
      },
    });
  });

  test("a host session on a project without the setting is left alone", () => {
    expect(withPortalSandbox(hostSession, status, false)).toEqual(status);
  });
});

describe("declared Portal commands", () => {
  test("wraps environment exports inside the supervised shell", () => {
    const command = recipeCommand({
      id: "app",
      name: "App",
      command: "./.agents/start.sh",
      serviceKey: "WEBAPP_PORT",
    });
    expect(command).toStartWith("bash -c ");
    expect(command).toContain('export WEBAPP_PORT="$PORT"');
    expect(command).toContain("exec ./.agents/start.sh");
    expect(command).not.toStartWith("exec export");
  });
});

describe("preview routing while a sandbox is unavailable", () => {
  test("keeps a preparing sandbox off the host preview path", () => {
    expect(
      unavailableSandboxPreviewStatus({
        sandbox: { provider: "daytona", lifecycle: "preparing" },
      }),
    ).toEqual({
      services: [],
      portalRecipes: [],
      sandboxLifecycle: "preparing",
    });
  });

  test("does not represent a missing awake sandbox as host-bootable", () => {
    expect(
      unavailableSandboxPreviewStatus({
        sandbox: {
          provider: "box",
          sandboxId: "bx_missing",
          lifecycle: "awake",
        },
      }),
    ).toEqual({ services: [], portalRecipes: [], sandboxLifecycle: "awake" });
  });

  test("leaves non-sandbox sessions on the host preview path", () => {
    expect(unavailableSandboxPreviewStatus({})).toBeNull();
  });
});
