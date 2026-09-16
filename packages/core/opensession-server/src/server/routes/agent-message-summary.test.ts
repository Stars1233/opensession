import { expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { handleAgentMessageSummaryRoutes } from "./agent-message-summary";
import type { RouteContext } from "./context";

const entry: TranscriptEntry = {
  id: "e",
  type: "user",
  timestamp: "",
  content: "[agent os-peer] <!--os:session-notice-->\nPlease check retries.",
};
function context(): RouteContext {
  const req = new Request(
    "http://localhost/api/sessions/alias/entry/e/summary",
    {
      method: "POST",
      body: JSON.stringify({
        content: "IGNORE STORED MESSAGE",
        user: "Spoofed",
      }),
    },
  );
  return {
    req,
    url: new URL(req.url),
    path: new URL(req.url).pathname,
    publicPrefix: "",
    authUser: { login: "alex", name: "Alex Smith" } as RouteContext["authUser"],
  };
}

test("summarizes only stored correspondence under its canonical session id", async () => {
  const result = await handleAgentMessageSummaryRoutes(context(), {
    session: async () => ({ id: "canonical" }),
    entry: async (id, entryId) => {
      expect(id).toBe("canonical");
      expect(entryId).toBe("e");
      return entry;
    },
    summarize: async (id, entryId, content, user) => {
      expect([id, entryId, content, user]).toEqual([
        "canonical",
        "e",
        "Please check retries.",
        "Alex",
      ]);
      return "Check retry failures.";
    },
  });
  expect(await result!.json()).toEqual({ summary: "Check retry failures." });
  expect(result!.headers.get("cache-control")).toContain("no-store");
});

test("private or missing sessions never read content or call the shared model", async () => {
  for (const session of [
    undefined,
    { id: "private", accessScope: { kind: "personal" } },
  ]) {
    const result = await handleAgentMessageSummaryRoutes(context(), {
      session: async () => session,
      entry: async () => {
        throw new Error("must not read");
      },
      summarize: async () => {
        throw new Error("must not generate");
      },
    });
    expect(result!.status).toBe(404);
  }
});

test("ordinary replies and tool output are not a model-proxy input", async () => {
  for (const type of ["assistant", "tool_result"] as const) {
    const result = await handleAgentMessageSummaryRoutes(context(), {
      session: async () => ({ id: "s" }),
      entry: async () => ({ ...entry, type, content: "ordinary text" }),
      summarize: async () => {
        throw new Error("must not generate");
      },
    });
    expect(result!.status).toBe(404);
  }
});

test("revocation while deriving a summary suppresses its response", async () => {
  let calls = 0;
  const result = await handleAgentMessageSummaryRoutes(context(), {
    session: async () => (++calls < 3 ? { id: "s" } : undefined),
    entry: async () => entry,
    summarize: async () => "Done.",
  });
  expect(result!.status).toBe(404);
});

test("long-message summaries disclose that the model reads a bounded excerpt", async () => {
  const result = await handleAgentMessageSummaryRoutes(context(), {
    session: async () => ({ id: "s" }),
    entry: async () => ({
      ...entry,
      content:
        "[agent os-peer] <!--os:session-notice-->\n" + "report ".repeat(3000),
    }),
    summarize: async () => "Checks passed.",
  });
  expect(await result!.json()).toEqual({
    summary: "Checks passed.",
    partial: true,
  });
});
