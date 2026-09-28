import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { RouteContext } from "./context";

const pushes: Array<{ user: string; payload: { title: string; url: string } }> =
  [];
const mentions: Array<{ person: string; sessionId: string; source: string }> =
  [];
const collaborators = new Map<string, string[]>();

mock.module("../people", () => ({
  teamDirectory: () => [
    { name: "Ada", fullName: "Ada Example" },
    { name: "Kent", fullName: "Kent Example" },
  ],
}));
mock.module("../notifications", () => ({
  notifyUser: async (user: string, event: { reason: string; url: string }) => {
    pushes.push({ user, payload: { title: event.reason, url: event.url } });
    return null;
  },
}));
mock.module("../mentions", () => ({
  addMention: async (
    person: string,
    mention: { sessionId: string; source: string },
  ) => {
    mentions.push({ person, ...mention });
    return { ...mention, by: "Kent", preview: "", ts: 1 };
  },
}));
mock.module("../ws-hub", () => ({ broadcastToAll: () => {} }));
mock.module("../workspaces", () => ({
  addWorkspaceCollaborator: async (id: string, name: string) => {
    if (id !== "ws-1") return null;
    const list = collaborators.get(id) || [];
    const added = !list.includes(name);
    if (added) collaborators.set(id, [...list, name]);
    return { workspace: { id, name: "Shared work" }, added };
  },
  removeWorkspaceCollaborator: async (id: string, name: string) => {
    if (id !== "ws-1") return null;
    collaborators.set(
      id,
      (collaborators.get(id) || []).filter((entry) => entry !== name),
    );
    return { id, name: "Shared work" };
  },
}));

const { handleWorkspaceCollaboratorRoutes } =
  await import("./workspace-collaborators");

function context(path: string, init?: RequestInit): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, init),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: null,
  };
}

function add(body: unknown, id = "ws-1") {
  return handleWorkspaceCollaboratorRoutes(
    context(`/api/workspaces/${id}/collaborators`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

/** Notifications are fired without awaiting; let them land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pushes.length = 0;
  mentions.length = 0;
  collaborators.clear();
});

describe("workspace collaborator routes", () => {
  test("adds a teammate and notifies them exactly once", async () => {
    const first = await add({ name: "ada", user: "Kent", sessionId: "os-1" });
    expect(first?.status).toBe(200);
    expect(await first?.json()).toMatchObject({ added: true });
    await settle();
    expect(collaborators.get("ws-1")).toEqual(["Ada"]);
    expect(mentions).toEqual([
      expect.objectContaining({
        person: "Ada",
        sessionId: "os-1",
        source: "collaborator",
      }),
    ]);
    expect(pushes).toEqual([
      {
        user: "Ada",
        payload: expect.objectContaining({
          title: "Kent added you to Shared work",
          url: "/session/os-1",
        }),
      },
    ]);

    const again = await add({ name: "Ada", user: "Kent", sessionId: "os-1" });
    expect(await again?.json()).toMatchObject({ added: false });
    await settle();
    expect(pushes).toHaveLength(1);
    expect(mentions).toHaveLength(1);
  });

  test("adding yourself sends nothing", async () => {
    await add({ name: "Kent", user: "Kent" });
    await settle();
    expect(collaborators.get("ws-1")).toEqual(["Kent"]);
    expect(pushes).toHaveLength(0);
  });

  test("without a session the push opens the workspace", async () => {
    await add({ name: "Ada", user: "Kent" });
    await settle();
    expect(mentions).toHaveLength(0);
    expect(pushes[0]?.payload.url).toBe("/workspace/ws-1");
  });

  test("rejects people outside the team and unknown workspaces", async () => {
    expect((await add({ name: "Mallory", user: "Kent" }))?.status).toBe(400);
    expect((await add({ name: "Ada", user: "Kent" }, "ws-2"))?.status).toBe(
      404,
    );
  });

  test("removes a collaborator", async () => {
    await add({ name: "Ada", user: "Kent" });
    const response = await handleWorkspaceCollaboratorRoutes(
      context("/api/workspaces/ws-1/collaborators/Ada", { method: "DELETE" }),
    );
    expect(response?.status).toBe(200);
    expect(collaborators.get("ws-1")).toEqual([]);
  });

  test("leaves other workspace paths to the generic routes", async () => {
    expect(
      await handleWorkspaceCollaboratorRoutes(
        context("/api/workspaces/ws-1", { method: "PATCH" }),
      ),
    ).toBeUndefined();
  });
});
