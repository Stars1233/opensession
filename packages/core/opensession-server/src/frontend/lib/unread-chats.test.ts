import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import {
  availableHeldChats,
  unreadChatsInOrder,
  type UnreadChat,
} from "./unread-chats";

const old = "2026-08-20T10:00:00.000Z";
const fresh = "2026-08-20T11:00:00.000Z";
function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    repo: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Michiel",
    title: id,
    createdAt: old,
    lastActivity: fresh,
    isRunning: false,
    ...patch,
  };
}
function row(key: string, sessions: UnifiedSession[]) {
  return { key, sessions, workspace: null };
}
const reads = Object.fromEntries(
  [
    "selected",
    "sibling",
    "before",
    "after",
    "running",
    "archived",
    "worker",
    "desk",
    "read",
    "snoozed",
  ].map((id) => [id, old]),
);

describe("Next unread destinations", () => {
  test("includes unread siblings before moving to other workspaces and wraps once", () => {
    const rows = [
      row("a", [session("before")]),
      row("b", [session("selected"), session("sibling")]),
      row("c", [session("after")]),
    ];
    expect(
      unreadChatsInOrder(rows, "selected", reads, new Set()).map((s) => s.id),
    ).toEqual(["sibling", "after", "before"]);
  });

  test("does not depend on mounted or expanded sidebar rows", () => {
    expect(
      unreadChatsInOrder(
        [row("collapsed", [session("after")])],
        "selected",
        reads,
        new Set(),
      ).map((s) => s.id),
    ).toEqual(["after"]);
  });

  test("excludes current, running, archived, workers, desk, read and never-visited sessions", () => {
    const rows = [
      row("a", [
        session("selected"),
        session("running", { isRunning: true }),
        session("archived", { archived: true }),
        session("worker", { parentSessionId: "selected" }),
        session("desk", { desk: true }),
        session("read", { lastActivity: old }),
        session("never-visited"),
      ]),
    ];
    expect(unreadChatsInOrder(rows, "selected", reads, new Set())).toEqual([]);
  });

  test("a running sibling does not hide another ready unread session", () => {
    const rows = [
      row("a", [session("running", { isRunning: true }), session("sibling")]),
    ];
    expect(
      unreadChatsInOrder(rows, null, reads, new Set()).map((s) => s.id),
    ).toEqual(["sibling"]);
  });

  test("respects snoozes and deduplicates overlapping pinned placements", () => {
    const ready = row("ready", [session("after")]);
    const rows = [row("later", [session("snoozed")]), ready, ready];
    expect(
      unreadChatsInOrder(rows, null, reads, new Set(["later"])).map(
        (s) => s.id,
      ),
    ).toEqual(["after"]);
  });

  test("uses each destination's project, not the current session's project", () => {
    const rows = [
      row("a", [session("selected"), session("after", { repo: "website" })]),
    ];
    expect(
      unreadChatsInOrder(rows, "selected", reads, new Set())[0]?.repo,
    ).toBe("website");
  });

  test("never falls back to a read session", () => {
    expect(
      unreadChatsInOrder(
        [row("a", [session("read", { lastActivity: old })])],
        null,
        reads,
        new Set(),
      ),
    ).toEqual([]);
  });

  test("orders siblings by newest unread activity and provides an honest fallback title", () => {
    const rows = [
      row("a", [
        session("before", { title: "", workspaceName: "Workspace" }),
        session("after", { lastActivity: "2026-08-20T12:00:00.000Z" }),
      ]),
    ];
    expect(unreadChatsInOrder(rows, null, reads, new Set())).toEqual([
      { id: "after", title: "after", workspace: "", repo: "opensession" },
      {
        id: "before",
        title: "Untitled session",
        workspace: "Workspace",
        repo: "opensession",
      },
    ]);
  });
});

describe("stable hover destinations", () => {
  const a: UnreadChat = {
    id: "a",
    title: "Original title",
    workspace: "",
    repo: "opensession",
  };
  const b: UnreadChat = {
    id: "b",
    title: "Another session",
    workspace: "",
    repo: "opensession",
  };
  test("new arrivals and renames do not change the held click target", () => {
    expect(availableHeldChats([a], [b, { ...a, title: "Renamed" }])).toEqual([
      a,
    ]);
  });
  test("read, hidden, archived or newly-running destinations are removed", () => {
    expect(availableHeldChats([a, b], [b])).toEqual([b]);
    expect(availableHeldChats([a], [b])).toEqual([]);
  });
  test("releasing the hold uses the latest list", () => {
    expect(availableHeldChats(null, [b, a])).toEqual([b, a]);
  });
});
