import { expect, test } from "bun:test";
import {
  SessionVoiceReplies,
  SessionVoiceAgentReply,
} from "./session-voice-replies";
import type { TranscriptEntry } from "./types";

function reply(id: string, content = "Done", seq = 1): TranscriptEntry {
  return {
    id,
    content,
    seq,
    type: "assistant",
    timestamp: new Date(seq * 1000).toISOString(),
  };
}

test("does not narrate existing history, reasoning, or busy partial replies", () => {
  const old = reply("old");
  const tracker = new SessionVoiceReplies([old]);
  expect(tracker.take([old], false)).toBeNull();
  const next = reply("next", "Partial", 3);
  expect(tracker.take([old, next], true)).toBeNull();
  expect(tracker.take([old, { ...next, content: "Finished" }], false)).toBe(
    "Finished",
  );
  expect(
    tracker.take([old, { ...next, content: "Finished" }], false),
  ).toBeNull();
  expect(
    tracker.take(
      [old, next, { ...reply("thinking", "Private", 4), isReasoning: true }],
      true,
    ),
  ).toBeNull();
});

test("history hydration and replay never read older replies aloud", () => {
  const tracker = new SessionVoiceReplies([reply("newest", "Latest", 10)]);
  expect(tracker.take([reply("older", "Old", 2)], false)).toBeNull();
  expect(tracker.take([reply("newest", "Latest", 10)], false)).toBeNull();
  expect(tracker.take([reply("new", "Fresh", 11)], false)).toBe("Fresh");
  expect(tracker.take([reply("newest", "Latest", 10)], false)).toBeNull();
});

test("a call started mid-turn speaks the completed version of that reply", () => {
  const partial = reply("partial", "Working", 5);
  const tracker = new SessionVoiceReplies([partial]);
  expect(tracker.take([{ ...partial, content: "Finished" }], true)).toBeNull();
  expect(tracker.take([{ ...partial, content: "Finished" }], false)).toBe(
    "Finished",
  );
});

test("an empty initial view does not narrate history fetched after the call starts", () => {
  const tracker = new SessionVoiceReplies([], 100_000);
  expect(tracker.take([reply("history", "Old", 50)], false)).toBeNull();
  expect(tracker.take([reply("new", "New", 101)], false)).toBe("New");
});

test("rewrites of an already spoken reply are not narrated twice", () => {
  const tracker = new SessionVoiceReplies([reply("old")]);
  expect(tracker.take([reply("new", "Done", 2)], false)).toBe("Done");
  expect(
    tracker.take([reply("new", "Done with linked references", 2)], false),
  ).toBeNull();
});

test("an approved question waits for its own queued turn, not the previous run", () => {
  const old = reply("old");
  const tracker = new SessionVoiceAgentReply("Check CI", [old]);
  const earlier = reply("earlier-run", "Previous job completed", 2);
  expect(tracker.take([old, earlier], false)).toBeNull();
  const question = {
    ...reply("question", "Check CI", 3),
    type: "user" as const,
  };
  const answer = reply("answer", "CI passes", 4);
  expect(tracker.take([old, earlier, question, answer], true)).toBeNull();
  expect(tracker.take([old, earlier, question, answer], false)).toBe(
    "CI passes",
  );
  expect(tracker.take([old, earlier, question, answer], false)).toBeNull();
});

test("an old identical prompt cannot satisfy a newly approved question", () => {
  const question = {
    ...reply("old-question", "Check CI", 1),
    type: "user" as const,
  };
  const old = reply("old-answer", "Old CI result", 2);
  const tracker = new SessionVoiceAgentReply("Check CI", [question, old]);
  expect(tracker.take([question, old], false)).toBeNull();
});
