import { expect, test } from "bun:test";
import type { UnifiedSession } from "../lib/types";
import { archivedMatchesSearch } from "./Archived";
import { archivedResults, searchArchived } from "./SessionSearch";

function row(over: Partial<UnifiedSession> = {}): UnifiedSession {
  // SAFETY: the matchers under test read only the fields set here.
  return {
    id: "os-0001-acme",
    source: "opensession",
    title: "Reduce GPU costs",
    branch: "how-many-t4-gpus",
    repo: "acme-app",
    startedBy: "Ada",
    lastActivity: "2026-01-01T00:00:00.000Z",
    archived: true,
    ...over,
  } as UnifiedSession;
}

test("archive search matches the title, branch, repo, owner and id", () => {
  const s = row();
  expect(archivedMatchesSearch(s, "gpu")).toBe(true);
  expect(archivedMatchesSearch(s, "T4")).toBe(true);
  expect(archivedMatchesSearch(s, "acme-app")).toBe(true);
  expect(archivedMatchesSearch(s, "ada")).toBe(true);
  expect(archivedMatchesSearch(s, " os-0001-acme ")).toBe(true);
  expect(archivedMatchesSearch(s, "billing")).toBe(false);
  expect(archivedMatchesSearch(s, "   ")).toBe(true);
});

test("archive search reads branch separators as spaces and matches every word", () => {
  const s = row({ title: "Debug review" });
  expect(archivedMatchesSearch(s, "how many t4")).toBe(true);
  expect(archivedMatchesSearch(s, "t4 gpus")).toBe(true);
  expect(archivedMatchesSearch(s, "gpus t4")).toBe(true);
  expect(archivedMatchesSearch(s, "t4 billing")).toBe(false);
});

test("the command menu finds archived sessions by branch and conversation", () => {
  const byBranch = row();
  const byTranscript = row({
    id: "os-0002-acme",
    title: "Billing export",
    branch: "billing-export",
  });
  const unrelated = row({ id: "os-0003-acme", title: "Docs", branch: "docs" });
  const pool = [byBranch, byTranscript, unrelated];

  expect(searchArchived("t4", pool, new Map())).toEqual([
    { session: byBranch, metaMatch: true },
  ]);
  const hits = searchArchived(
    "t4",
    pool,
    new Map([["os-0002-acme", "…about t4 capacity…"]]),
  );
  expect(hits.map((h) => h.session.id)).toEqual([
    "os-0001-acme",
    "os-0002-acme",
  ]);
  expect(hits[1].metaMatch).toBe(false);
  expect(searchArchived("", pool, new Map())).toEqual([]);
});

test("archive search matches the workspace name the sidebar showed", () => {
  const s = row({
    title: "Debug review",
    branch: "fix-thing",
    workspaceName: "How many T4 GPUs do we use",
  });
  expect(archivedMatchesSearch(s, "t4 gpus")).toBe(true);
});

test("the command menu lists an archived workspace by its name", () => {
  const ws = {
    workspaceId: "ws-t4",
    workspaceName: "How many T4 GPUs do we use",
  };
  const pool = [
    row({ id: "os-a", title: "Debug review", ...ws }),
    row({ id: "os-b", title: "Reduce GPU costs", ...ws }),
    row({ id: "os-c", title: "T4 pricing notes", ...ws }),
  ];
  const results = archivedResults("t4", pool, new Set(), new Map());
  expect(results[0]).toMatchObject({
    type: "workspace",
    category: "Archived",
    workspace: { id: "ws-t4", name: "How many T4 GPUs do we use" },
  });
  // Sessions the workspace row covers stay folded into it, unless their own
  // title matches too.
  expect(
    results.slice(1).map((r) => (r.type === "session" ? r.session.id : r.type)),
  ).toEqual(["os-c"]);
  // A workspace with live sessions is the live group's to show.
  expect(
    archivedResults("t4", pool, new Set(["ws-t4"]), new Map())[0],
  ).toMatchObject({ type: "session" });
});
