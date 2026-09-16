import { expect, test } from "bun:test";
import {
  createAgentMessageSummarizer,
  normalizeAgentSummary,
} from "./agent-message-summary";

test("normalizes output to a bounded single plain line", () => {
  expect(normalizeAgentSummary('"Retries fixed.\nTests pass."')).toBe(
    "Retries fixed. Tests pass.",
  );
  expect(normalizeAgentSummary(" ")).toBeNull();
  expect(normalizeAgentSummary("x".repeat(400))!.length).toBeLessThanOrEqual(
    320,
  );
});

test("one-shot requests are deduplicated and cached by message content", async () => {
  let calls = 0;
  let finish!: (value: string) => void;
  const summarize = createAgentMessageSummarizer(async (prompt, opts) => {
    calls++;
    expect(opts?.label).toBe("agent-message-summary");
    expect(opts?.system).toContain("untrusted data");
    expect(prompt.length).toBeLessThan(12_200);
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const a = summarize("s", "e", "Check retries", "Alex");
  const b = summarize("s", "e", "Check retries", "Alex");
  expect(calls).toBe(1);
  finish("Check retry failures.");
  expect(await a).toBe(await b);
  expect(await summarize("s", "e", "Check retries", "Alex")).toBe(
    "Check retry failures.",
  );
  expect(calls).toBe(1);
  const edited = summarize("s", "e", "Now fixed", "Alex");
  expect(calls).toBe(2);
  finish("Retries fixed.");
  expect(await edited).toBe("Retries fixed.");
});

test("bounds excerpts and safely falls back when the model fails", async () => {
  const summarize = createAgentMessageSummarizer(async (prompt) => {
    expect(prompt.length).toBeLessThan(12_200);
    expect(prompt).toContain("middle omitted");
    expect(prompt).toContain("tail-marker");
    throw new Error("provider unavailable");
  });
  expect(
    await summarize("s", "e", "long ".repeat(8000) + "tail-marker"),
  ).toBeNull();
});

test("bounds concurrent derived requests instead of flooding the one-shot pool", async () => {
  let calls = 0;
  const finishes: Array<(value: null) => void> = [];
  const summarize = createAgentMessageSummarizer(async () => {
    calls++;
    return new Promise<null>((resolve) => finishes.push(resolve));
  });
  const pending = Array.from({ length: 32 }, (_, i) =>
    summarize("s", `${i}`, "Message"),
  );
  expect(await summarize("s", "overflow", "Message")).toBeNull();
  expect(calls).toBe(32);
  finishes.forEach((resolve) => resolve(null));
  await Promise.all(pending);
});
