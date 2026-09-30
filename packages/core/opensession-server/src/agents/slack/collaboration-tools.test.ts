import { beforeEach, describe, expect, mock, test } from "bun:test";

type Request = {
  to: string;
  by: string;
  at: string;
  accepted?: { by: string; at: string };
};

const requests = new Map<string, Request>();
const reviewerCalls: Array<{
  sessionId: string;
  reviewer: string;
  by: string;
}> = [];
const workspaces = new Map<
  string,
  {
    id: string;
    name: string;
    createdBy: string;
    collaborators?: Array<{ name: string; by: string; at: string }>;
  }
>();
const addCalls: Array<{ id: string; name: string; sessionId: string | null }> =
  [];

const sessions: Record<string, { id: string; workspaceId?: string }> = {
  "bks-current": { id: "bks-current", workspaceId: "ws-1" },
  "bks-loose": { id: "bks-loose" },
};

mock.module("../../server/audit", () => ({ audit: () => {} }));
mock.module("../../server/github-auth", () => ({
  githubCredentialForRun: () => null,
}));
mock.module("../../server/people", () => ({
  teamFirstNames: () => ["Ada", "Kent"],
}));
mock.module("../../server/session-cache", () => ({
  findSessionAsync: async (id: string) => sessions[id] ?? null,
}));
mock.module("../../server/session-review", () => ({
  resolveReviewer: (ref: string) =>
    ({ ada: "Ada", "ada example": "Ada", "acme/reviewers": "acme/reviewers" })[
      ref.trim().toLowerCase()
    ] ?? null,
  reviewerChoices: () => ["Ada", "Kent", "acme/reviewers"],
  sessionReviewRequest: (session: { id: string }) =>
    requests.get(session.id) ?? null,
  setSessionReviewer: async (opts: {
    session: { id: string };
    sessionId: string;
    reviewer: string;
    by: string;
  }) => {
    reviewerCalls.push({
      sessionId: opts.sessionId,
      reviewer: opts.reviewer,
      by: opts.by,
    });
    if (opts.reviewer)
      requests.set(opts.session.id, {
        to: opts.reviewer,
        by: opts.by,
        at: "2026-01-01T00:00:00.000Z",
      });
    else requests.delete(opts.session.id);
    return { ok: true };
  },
  acceptSessionReview: async (
    session: { id: string },
    _sessionId: string,
    accept: boolean,
    by: string,
  ) => {
    const existing = requests.get(session.id);
    if (!existing)
      return { ok: false, status: 400, error: "No review request to accept" };
    requests.set(session.id, {
      ...existing,
      ...(accept ? { accepted: { by, at: "2026-01-02T00:00:00.000Z" } } : {}),
    });
    return { ok: true };
  },
}));
mock.module("../../server/collaborators", () => ({
  teammateName: (name: string) =>
    ({ ada: "Ada", kent: "Kent" })[name.trim().toLowerCase()] ?? null,
  addCollaborator: async (
    id: string,
    name: string,
    by: string,
    sessionId: string | null,
  ) => {
    const workspace = workspaces.get(id);
    if (!workspace) return null;
    addCalls.push({ id, name, sessionId });
    const list = workspace.collaborators || [];
    const added = !list.some((c) => c.name === name);
    if (added)
      workspace.collaborators = [...list, { name, by, at: "2026-01-01" }];
    return { workspace, added };
  },
}));
mock.module("../../server/workspaces", () => ({
  getWorkspace: async (id: string) => workspaces.get(id) ?? null,
  removeWorkspaceCollaborator: async (id: string, name: string) => {
    const workspace = workspaces.get(id);
    if (!workspace) return null;
    workspace.collaborators = (workspace.collaborators || []).filter(
      (c) => c.name !== name,
    );
    return workspace;
  },
}));

const { collaborationTools } = await import("./collaboration-tools");

const tools = collaborationTools({
  createdBy: "Kent",
  currentSessionId: "bks-current",
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const found = tools.find((t: { name: string }) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  const result = await found.handler(args, {});
  return result.content[0].text as string;
}

beforeEach(() => {
  requests.clear();
  reviewerCalls.length = 0;
  addCalls.length = 0;
  workspaces.clear();
  workspaces.set("ws-1", {
    id: "ws-1",
    name: "Shared work",
    createdBy: "Kent",
  });
});

describe("reviewer tools", () => {
  test("set, read, accept, and remove on the current session", async () => {
    expect(await call("get_session_reviewer")).toContain("has no reviewer");

    const set = await call("set_session_reviewer", { reviewer: "Ada Example" });
    expect(reviewerCalls).toEqual([
      { sessionId: "bks-current", reviewer: "Ada", by: "Kent" },
    ]);
    expect(set).toContain("Reviewer: Ada");
    expect(set).toContain("Not reviewed yet");

    expect(await call("accept_session_review")).toContain("Reviewed by Kent");

    expect(await call("remove_session_reviewer")).toContain(
      "Removed the reviewer",
    );
    expect(reviewerCalls.at(-1)?.reviewer).toBe("");
    expect(await call("get_session_reviewer")).toContain("has no reviewer");
  });

  test("refuses an unknown reviewer before touching the session", async () => {
    const out = await call("set_session_reviewer", { reviewer: "Mallory" });
    expect(out).toContain("not a teammate or review team");
    expect(out).toContain("acme/reviewers");
    expect(reviewerCalls).toEqual([]);
  });

  test("accepting without a request reports it", async () => {
    expect(await call("accept_session_review")).toBe(
      "No review request to accept",
    );
  });

  test("an unknown session is reported", async () => {
    expect(
      await call("get_session_reviewer", { session_id: "bks-missing" }),
    ).toContain("No session with id `bks-missing`");
  });
});

describe("collaborator tools", () => {
  test("add, list, and remove on the current session's workspace", async () => {
    const added = await call("add_collaborator", { name: "ada" });
    expect(added).toContain("Added Ada.");
    expect(addCalls).toEqual([
      { id: "ws-1", name: "Ada", sessionId: "bks-current" },
    ]);

    expect(await call("add_collaborator", { name: "Ada" })).toContain(
      "Ada was already a collaborator.",
    );

    const listed = await call("list_collaborators");
    expect(listed).toContain("Creator: Kent");
    expect(listed).toContain("- Ada (added by Kent");

    expect(await call("remove_collaborator", { name: "Ada" })).toContain(
      "Removed Ada.",
    );
    expect(await call("list_collaborators")).toContain("Collaborators: none");
  });

  test("an explicit workspace id wins over the session", async () => {
    workspaces.set("ws-2", { id: "ws-2", name: "Other", createdBy: "Ada" });
    await call("add_collaborator", { name: "Kent", workspace_id: "ws-2" });
    expect(workspaces.get("ws-2")?.collaborators?.[0]?.name).toBe("Kent");
    expect(workspaces.get("ws-1")?.collaborators).toBeUndefined();
  });

  test("refuses unknown teammates and sessions outside a workspace", async () => {
    expect(await call("add_collaborator", { name: "Mallory" })).toContain(
      "not a teammate",
    );
    expect(
      await call("list_collaborators", { session_id: "bks-loose" }),
    ).toContain("is not in a workspace");
    expect(await call("remove_collaborator", { name: "Kent" })).toContain(
      "Kent is not a collaborator.",
    );
    expect(addCalls).toEqual([]);
  });
});
