import { describe, expect, test } from "bun:test";
import {
  archivePlainSessionCandidates,
  resolvePlainDiscussion,
} from "./plain-archive";
import type { NativeSessionFile } from "./types";

describe("Plain archive sweep", () => {
  test("continues after one session projection is quarantined", async () => {
    const projected: string[] = [];
    const released: string[] = [];
    const failures: Array<[string, unknown]> = [];
    const sessions = ["quarantined", "healthy"].map((id) => ({
      data: { id, plainThreadId: "thread-1" } as NativeSessionFile,
    }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        projected.push(sessionId);
        if (sessionId === "quarantined") throw new Error("session quarantined");
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      (sessionId, error) => failures.push([sessionId, error]),
      (sessionId) => released.push(sessionId),
    );

    expect(archived).toBe(1);
    expect(projected).toEqual(["quarantined", "healthy"]);
    expect(released).toEqual(["healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe("quarantined");
  });

  test("resolves a session's discussion before archiving it, and only then", async () => {
    const events: string[] = [];
    const sessions = [
      {
        id: "with-discussion",
        plainThreadId: "thread-1",
        plainDiscussionId: "thd_a",
      },
      { id: "note-only", plainThreadId: "thread-1" },
      {
        id: "other-thread",
        plainThreadId: "thread-2",
        plainDiscussionId: "thd_b",
      },
    ].map((data) => ({ data: data as NativeSessionFile }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        events.push(`archive:${sessionId}`);
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      () => {},
      () => {},
      async (discussionId) => {
        events.push(`resolve:${discussionId}`);
      },
    );

    expect(archived).toBe(2);
    expect(events).toEqual([
      "resolve:thd_a",
      "archive:with-discussion",
      "archive:note-only",
    ]);
  });

  test("keeps a session unarchived when its discussion cannot be resolved, so the sweep retries it", async () => {
    const projected: string[] = [];
    const failures: Array<[string, unknown]> = [];
    const sessions = [
      {
        id: "plain-down",
        plainThreadId: "thread-1",
        plainDiscussionId: "thd_a",
      },
      { id: "healthy", plainThreadId: "thread-1", plainDiscussionId: "thd_b" },
    ].map((data) => ({ data: data as NativeSessionFile }));

    const archived = await archivePlainSessionCandidates(
      "thread-1",
      sessions,
      async (sessionId, _operation, mutate) => {
        projected.push(sessionId);
        return undefined as Awaited<ReturnType<typeof mutate>>;
      },
      (sessionId, error) => failures.push([sessionId, error]),
      () => {},
      async (discussionId) => {
        if (discussionId === "thd_a")
          throw new Error("Plain API responded 503");
      },
    );

    expect(archived).toBe(1);
    expect(projected).toEqual(["healthy"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe("plain-down");
  });

  test("treats a missing agent key as a resolution failure instead of archiving past the discussion", async () => {
    const saved = {
      PLAIN_AGENT_API_KEY: process.env.PLAIN_AGENT_API_KEY,
      PLAIN_API_KEY: process.env.PLAIN_API_KEY,
    };
    delete process.env.PLAIN_AGENT_API_KEY;
    delete process.env.PLAIN_API_KEY;
    try {
      await expect(resolvePlainDiscussion("thd_a")).rejects.toThrow(
        "not configured",
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
