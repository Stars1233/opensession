import { expect, test } from "bun:test";
import {
  isSessionVoiceHelperTarget,
  SESSION_VOICE_HELPER_TARGETS,
  SESSION_VOICE_INSTRUCTIONS,
  SESSION_VOICE_TARGETS,
  sessionVoiceContext,
} from "./session-voice";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";

function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
): TranscriptEntry {
  return { id, type, content, timestamp: "2026-09-18T10:00:00Z" };
}

test("voice context contains the thread's answers and tool results, never hidden engine context", () => {
  const context = sessionVoiceContext([
    entry("one", "user", "Why did the test fail?"),
    entry("secret", "system", "Hidden system instructions"),
    { ...entry("thought", "assistant", "Hidden reasoning"), isReasoning: true },
    {
      ...entry("injection", "user", "Hidden context"),
      contextInjection: { source: "private" },
    },
    {
      ...entry("tool", "tool_result", "The retry loop ran twice"),
      toolName: "bash",
    },
    entry("answer", "assistant", "Fixed the retry loop"),
  ]);
  expect(context).toContain("Why did the test fail?");
  expect(context).toContain("The retry loop ran twice");
  expect(context).toContain("Fixed the retry loop");
  expect(context).not.toContain("Hidden");
  expect(context.indexOf("retry loop ran")).toBeLessThan(
    context.indexOf("Fixed"),
  );
});

test("helper targets are the tool-less tiers; only the session agent needs spoken permission", () => {
  expect([...SESSION_VOICE_HELPER_TARGETS]).toEqual([
    "luna",
    "terra",
    "conversation",
  ]);
  expect([...SESSION_VOICE_TARGETS]).toEqual([
    ...SESSION_VOICE_HELPER_TARGETS,
    "session_agent",
  ]);
  expect(isSessionVoiceHelperTarget("conversation")).toBe(true);
  expect(isSessionVoiceHelperTarget("session_agent")).toBe(false);
  // The spoken-permission gate is explained once, for agent work only, and
  // helper tiers are chosen automatically by difficulty.
  const [beforeAgent, agentParagraph] = SESSION_VOICE_INSTRUCTIONS.split(
    "Use session_agent only",
  );
  expect(beforeAgent).toContain("do not ask permission");
  expect(beforeAgent).not.toContain("asks permission aloud");
  expect(agentParagraph).toContain("asks permission aloud");
  expect(SESSION_VOICE_INSTRUCTIONS).toContain("conversation for the hardest");
});

test("voice context is bounded and explicitly marks truncated messages", () => {
  const context = sessionVoiceContext(
    Array.from({ length: 1000 }, (_, index) =>
      entry(String(index), "assistant", `${index}: ${"x".repeat(10_000)}`),
    ),
  );
  expect(context.length).toBeLessThanOrEqual(48_080);
  expect(context).toContain("999:");
  expect(context).toContain('"truncated":true');
  expect(context).not.toContain('"text":"0:');
});
