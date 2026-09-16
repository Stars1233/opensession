import { beforeEach, expect, mock, test } from "bun:test";
import type { CreateSessionOpts } from "../../server/session-control";
import type { QueuedMessage } from "./queue";
import {
  linkThreadInIndex,
  rebuildIndex,
  sessionForSlackConversation,
  sessionForThread,
  unlinkThreadsInIndex,
} from "../../server/slack-links";

let legacy: Record<string, unknown> | null = null;
let source: Record<string, unknown> | undefined;
let saved = 0;
let created: CreateSessionOpts[] = [];
let delivered: unknown[][] = [];
let failCreate = false;
let afterCreate = () => {};
let cancelledSessions: string[] = [];
const sessions = new Map<string, Record<string, unknown>>();
mock.module("../../server/session-control", () => ({
  getSessionControl: () => ({
    getSession: async (id: string) => sessions.get(id),
    createSession: async (opts: CreateSessionOpts) => {
      expect(saved).toBeGreaterThan(0);
      created.push(opts);
      if (failCreate) throw new Error("retry admission");
      sessions.set("os-native", {
        id: "os-native",
        slackOrigin: opts.slackOrigin,
      });
      afterCreate();
      return { id: "os-native" };
    },
    cancelSession: async (id: string) => {
      cancelledSessions.push(id);
      return true;
    },
    deliverToSession: async (...args: unknown[]) => {
      delivered.push(args);
      return { status: "queued" };
    },
  }),
}));
mock.module("../../server/session-cache", () => ({
  findSessionAsync: async () => source,
}));
mock.module("../../server/session-create", () => ({
  forkHandoffContext: async () => "Preserved legacy conversation",
}));
mock.module("../../server/worktree", () => ({
  getRepo: (id?: string) => ({ id: id || "default" }),
  isSharedCheckoutDir: (dir: string) => dir === "/shared",
  repoForPathOrNull: () => ({ id: "tella" }),
}));
mock.module("../../server/shared/user-mappings", () => ({
  githubLoginForTrustedSlackId: (id: string) =>
    id === "U1" ? "verified-login" : undefined,
  slackIdToFirstName: () => "Michiel",
}));
mock.module("./slack-api", () => ({
  getChannelKind: async () => ({ isDM: false, isPrivate: true }),
  downloadSlackImages: async () => ({
    images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    note: "Attachment note",
  }),
}));
mock.module("./memory", () => ({
  renderMemoryForPrompt: async () => "Scoped memory",
}));
mock.module("./state", () => ({ loadSession: async () => legacy }));
mock.module("./queue", () => ({
  saveQueueToDisk: async () => {
    saved++;
  },
}));
const { dispatchSlackSessionMessage } = await import("./session-dispatch");

function message(patch: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    prompt: "Check if the editor is broken. Do not edit code.",
    channel: "C1",
    threadTs: "123.1",
    messageTs: "123.1",
    userId: "U1",
    userName: "Michiel",
    isNewSession: true,
    repoId: "tella",
    ...patch,
  };
}
beforeEach(() => {
  rebuildIndex([]);
  legacy = null;
  source = undefined;
  saved = 0;
  created = [];
  delivered = [];
  failCreate = false;
  afterCreate = () => {};
  cancelledSessions = [];
  sessions.clear();
});

test("Slack questions use native code-session creation and its default Sandbox policy", async () => {
  expect(await dispatchSlackSessionMessage("C1-123.1", message())).toBe(
    "os-native",
  );
  expect(created[0]).toMatchObject({
    mode: "code",
    repo: "tella",
    user: "Michiel",
    createdByLogin: "verified-login",
    requestId: "slack:C1:123.1",
    requestScope: "slack:C1-123.1",
    slackOrigin: {
      sessionKey: "C1-123.1",
      channel: "C1",
      threadTs: "123.1",
      messageTs: "123.1",
    },
  });
  expect(created[0]?.sandbox).toBeUndefined();
  expect(created[0]?.mcpServers).toBeUndefined();
  expect(created[0]?.branch).toBeUndefined();
  expect(sessionForThread("C1", "123.1")).toBe("os-native");
});

test("legacy owned worktrees and history survive without a remote clone losing edits", async () => {
  legacy = {
    worktreeDir: "/owned",
    branch: "existing-pr",
    repoId: "other",
    model: "pi/test",
  };
  source = { id: "slack-C1-123.1" };
  await dispatchSlackSessionMessage("C1-123.1", message());
  expect(created[0]).toMatchObject({
    branch: "existing-pr",
    repo: "other",
    sandbox: "local",
    model: "pi/test",
  });
  expect(created[0]?.prompt).toContain("Preserved legacy conversation");
});

test("explicit legacy ask policy survives native migration and admission retry", async () => {
  legacy = { mode: "ask", worktreeDir: "/shared", repoId: "other" };
  source = { id: "slack-C1-123.1", mode: "ask" };
  const msg = message();
  failCreate = true;
  await expect(dispatchSlackSessionMessage("C1-123.1", msg)).rejects.toThrow(
    "retry admission",
  );
  expect(created[0]?.mode).toBe("ask");
  legacy = { mode: "code" };
  failCreate = false;
  await dispatchSlackSessionMessage("C1-123.1", msg);
  expect(created[1]?.mode).toBe("ask");
  expect(saved).toBe(1);
});

test("native migration honors the canonical session's read-only mode overlay", async () => {
  legacy = { mode: "code", worktreeDir: "/owned", branch: "task" };
  source = { id: "slack-C1-123.1", mode: "ask" };
  await dispatchSlackSessionMessage("C1-123.1", message());
  expect(created[0]?.mode).toBe("ask");
});

test("legacy shared-checkout questions receive their own native workspace", async () => {
  legacy = { worktreeDir: "/shared", branch: "main" };
  source = { id: "slack-C1-123.1" };
  await dispatchSlackSessionMessage("C1-123.1", message());
  expect(created[0]?.branch).toBeUndefined();
  expect(created[0]?.sandbox).toBeUndefined();
  expect(created[0]?.prompt).toContain("Preserved legacy conversation");
});

test("follow-ups including images go to native delivery, not a second runner", async () => {
  await dispatchSlackSessionMessage("C1-123.1", message());
  await dispatchSlackSessionMessage(
    "C1-123.1",
    message({
      messageTs: "124.1",
      files: [
        {
          id: "F1",
          name: "shot.png",
          mimetype: "image/png",
          url: "https://slack.test/file",
          size: 5,
        },
      ],
    }),
  );
  expect(created).toHaveLength(1);
  expect(delivered[0]).toEqual([
    "os-native",
    expect.stringContaining("Attachment note"),
    "U1",
    expect.objectContaining({
      busy: "queue",
      deliveryId: "slack:C1:124.1",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    }),
  ]);
});

test("code task, question, then edit continue the same native session", async () => {
  await dispatchSlackSessionMessage(
    "C1-123.1",
    message({ prompt: "Fix the editor" }),
  );
  await dispatchSlackSessionMessage(
    "C1-123.1",
    message({ messageTs: "124.1", prompt: "Why did you change that?" }),
  );
  await dispatchSlackSessionMessage(
    "C1-123.1",
    message({ messageTs: "125.1", prompt: "Make another edit" }),
  );
  expect(created).toHaveLength(1);
  expect(created[0]?.mode).toBe("code");
  expect(delivered.map(([id]) => id)).toEqual(["os-native", "os-native"]);
});

test("linked automations stay on their existing permission-scoped session", async () => {
  sessions.set("os-automation", {
    id: "os-automation",
    automation: "untrusted",
  });
  linkThreadInIndex("os-automation", "C1", "123.1");
  await dispatchSlackSessionMessage("C1-123.1", message());
  expect(created).toHaveLength(0);
  expect(delivered[0]?.[0]).toBe("os-automation");
});

test("retry reuses the frozen native creation identity", async () => {
  const msg = message();
  failCreate = true;
  await expect(dispatchSlackSessionMessage("C1-123.1", msg)).rejects.toThrow(
    "retry admission",
  );
  const frozen = msg.nativeCreate;
  legacy = { branch: "changed", worktreeDir: "/owned" };
  failCreate = false;
  await dispatchSlackSessionMessage("C1-123.1", msg);
  expect(created[1]).toBe(frozen!);
  expect(saved).toBe(1);
  // Replay after native acceptance also cannot submit a second opening turn.
  await dispatchSlackSessionMessage("C1-123.1", msg);
  expect(created).toHaveLength(2);
  expect(delivered).toHaveLength(0);
});

test("worktree-channel identity survives restart and spans Slack threads", async () => {
  const origin = {
    sessionKey: "C1",
    channel: "C1",
    threadTs: "123.1",
    messageTs: "123.1",
  };
  sessions.set("os-native", { id: "os-native", slackOrigin: origin });
  rebuildIndex([
    {
      id: "os-native",
      slackOrigin: origin,
      slackThreads: [{ channel: "C1", threadTs: "123.1" }],
    },
  ]);
  expect(sessionForSlackConversation("C1")).toBe("os-native");
  await dispatchSlackSessionMessage(
    "C1",
    message({ threadTs: "200.1", messageTs: "200.1" }),
  );
  expect(created).toHaveLength(0);
  expect(delivered[0]?.[0]).toBe("os-native");
  unlinkThreadsInIndex("os-native");
  expect(sessionForSlackConversation("C1")).toBeUndefined();
});

test("legacy automation provenance is never promoted to interactive authority", async () => {
  legacy = { worktreeDir: "/owned", branch: "review" };
  source = {
    id: "slack-C1-123.1",
    automationDescendantPolicy: { publication: "branch-pr-only" },
  };
  await dispatchSlackSessionMessage("C1-123.1", message());
  expect(created).toHaveLength(0);
  expect(delivered[0]?.[0]).toBe("slack-C1-123.1");
});

test("Stop during native admission cancels the accepted native session", async () => {
  let cancelled = false;
  afterCreate = () => {
    cancelled = true;
  };
  await dispatchSlackSessionMessage("C1-123.1", message(), () => cancelled);
  expect(cancelledSessions).toEqual(["os-native"]);
});

test("Stop before admission starts no workspace or agent", async () => {
  await expect(
    dispatchSlackSessionMessage("C1-123.1", message(), () => true),
  ).rejects.toThrow("cancelled before admission");
  expect(created).toHaveLength(0);
  expect(delivered).toHaveLength(0);
});

test("Slack ingress cannot carry a parallel runner or a separate tool allowlist", async () => {
  const source = await Bun.file(
    new URL("./handlers.ts", import.meta.url),
  ).text();
  expect(source).toContain("dispatchSlackSessionMessage");
  expect(source).not.toContain("runAgent(");
  expect(source).not.toContain("registerSessionMcpServers");
  expect(source).not.toContain("createAdminMcpServer");
  expect(source).not.toContain("createRepoWorktree(");
});
