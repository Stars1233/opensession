import { expect, test } from "bun:test";
import { SessionVoiceRuntime } from "./session-voice-runtime";
import type { SessionVoiceClient } from "./session-voice-client";
import type { PromptOutboxInput } from "./prompt-outbox";
import type { TranscriptEntry } from "./types";

function setup() {
  let options: ConstructorParameters<typeof SessionVoiceClient>[0] | undefined;
  let stops = 0;
  let user = "Alice";
  const prompts: PromptOutboxInput[] = [];
  const contexts: string[] = [];
  const replies: string[] = [];
  const runtime = new SessionVoiceRuntime({
    currentUser: () => user,
    enqueue: (input) => {
      prompts.push(input);
    },
    createClient: (opts) => {
      options = opts;
      return {
        start: async () => opts.onState("listening"),
        setPaused: (paused) => opts.onState(paused ? "paused" : "listening"),
        stop: () => {
          stops++;
        },
        updateContext: (context) => {
          contexts.push(context);
        },
        agentReply: (reply) => {
          replies.push(reply);
        },
      };
    },
  });
  return {
    runtime,
    prompts,
    contexts,
    replies,
    options: () => options!,
    stops: () => stops,
    switchUser: () => {
      user = "Bob";
    },
  };
}
function entry(
  id: string,
  type: TranscriptEntry["type"],
  content: string,
  seq: number,
): TranscriptEntry {
  return {
    id,
    type,
    content,
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
  };
}
const seed = [entry("old", "assistant", "Existing answer", 1)];

test("navigation moves the call to the global panel without hanging up or changing its source", () => {
  const h = setup();
  const sourceView = Symbol();
  const otherView = Symbol();
  h.runtime.setView(sourceView, "source", true);
  h.runtime.start({
    sessionId: "source",
    title: "Original thread",
    entries: seed,
    busy: false,
  });
  expect(h.runtime.getSnapshot().sourceVisible).toBe(true);
  h.runtime.removeView(sourceView);
  h.runtime.setView(otherView, "other", true);
  expect(h.stops()).toBe(0);
  expect(h.runtime.getSnapshot()).toMatchObject({
    active: true,
    sessionId: "source",
    sourceVisible: false,
  });
  h.runtime.setView(sourceView, "source", true);
  expect(h.runtime.getSnapshot().sourceVisible).toBe(true);
  expect(h.stops()).toBe(0);
});

test("approved work keeps targeting the original thread after its composer unmounts", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: true,
  });
  h.runtime.setView(Symbol(), "other", true);
  expect(await h.options().onAgentRequest("Check the test")).toBe(true);
  expect(h.prompts).toEqual([
    {
      sessionId: "source",
      content: "Check the test",
      user: "Alice",
      busyMode: "queue",
    },
  ]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "other",
    entries: [entry("other-answer", "assistant", "Wrong thread", 5)],
  });
  expect(h.contexts).toEqual([]);
  h.runtime.receive({
    type: "transcript_append",
    sessionId: "source",
    entries: [
      entry("question", "user", "Check the test", 2),
      entry("answer", "assistant", "The test passes", 3),
    ],
  });
  expect(h.replies).toEqual([]);
  h.runtime.receive({
    type: "session_status",
    sessionId: "source",
    isRunning: false,
  });
  expect(h.replies).toEqual(["The test passes"]);
  expect(h.contexts[0]).toContain("The test passes");
});

test("explicit hangup or identity change prevents a stale call from submitting work", async () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.switchUser();
  expect(await h.options().onAgentRequest("Do not send")).toBe(false);
  h.runtime.stop();
  expect(await h.options().onAgentRequest("Do not send")).toBe(false);
  expect(h.prompts).toEqual([]);
  expect(h.stops()).toBe(1);
});

test("starting a new call replaces the old call only on explicit request", () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.runtime.start({
    sessionId: "other",
    title: "Other",
    entries: [],
    busy: false,
  });
  expect(h.stops()).toBe(1);
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "other",
    active: true,
  });
});

test("the global pause control retains the call and source", () => {
  const h = setup();
  h.runtime.start({
    sessionId: "source",
    title: "Original",
    entries: seed,
    busy: false,
  });
  h.runtime.togglePause();
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "source",
    state: "paused",
    active: true,
  });
  h.runtime.togglePause();
  expect(h.runtime.getSnapshot()).toMatchObject({
    sessionId: "source",
    state: "listening",
    active: true,
  });
  expect(h.stops()).toBe(0);
});
