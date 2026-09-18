import { expect, test } from "bun:test";
import { sessionVoiceContext } from "./session-voice";
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
