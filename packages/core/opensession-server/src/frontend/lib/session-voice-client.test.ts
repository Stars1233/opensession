import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import {
  SessionVoiceClient,
  type SessionVoiceState,
} from "./session-voice-client";

const restores: Array<() => void> = [];
function install(name: string, replacement: PropertyDescriptor) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...replacement,
  });
  restores.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

interface TestMicrophone {
  getTracks(): Array<{ stop(): void; onended: null }>;
}
interface TestEvent {
  type: string;
  item_id?: string;
  transcript?: string;
  name?: string;
  arguments?: string;
  response?: { status: string };
}
const commandSchema = z.object({
  type: z.string(),
  response: z
    .object({
      conversation: z.string(),
      input: z.array(
        z.object({ content: z.array(z.object({ text: z.string() })) }),
      ),
    })
    .optional(),
});
class TestChannel {
  readyState = "open";
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<z.infer<typeof commandSchema>> = [];
  send(value: string) {
    this.sent.push(commandSchema.parse(JSON.parse(value)));
  }
  close() {}
}
function setup(options?: {
  mic?: () => Promise<TestMicrophone>;
  onText?: (text: string) => boolean | Promise<boolean>;
  denied?: boolean;
}) {
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  let stopped = 0;
  let closed = 0;
  let fetches = 0;
  let requestBody = "";
  const track = {
    stop() {
      stopped++;
    },
    onended: null,
  };
  const stream = { getTracks: () => [track] };
  const channel = new TestChannel();
  const sent = channel.sent;
  const states: Array<[SessionVoiceState, string | undefined]> = [];
  const prompts: string[] = [];
  install("window", { value: windowEvents });
  install("document", {
    value: Object.assign(documentEvents, {
      createElement: () => ({
        play: async () => {},
        pause() {},
        srcObject: null,
      }),
    }),
  });
  install("navigator", {
    value: {
      mediaDevices: {
        getUserMedia:
          options?.mic ??
          (async () => {
            if (options?.denied)
              throw new DOMException("Denied", "NotAllowedError");
            return stream;
          }),
      },
    },
  });
  install("RTCPeerConnection", {
    value: class {
      localDescription = { sdp: "offer" };
      addTrack() {}
      createDataChannel() {
        return channel;
      }
      async createOffer() {
        return this.localDescription;
      }
      async setLocalDescription() {}
      async setRemoteDescription() {
        channel.onopen?.();
      }
      close() {
        closed++;
      }
    },
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toEndWith("/api/sessions/test-session/voice");
        fetches++;
        requestBody = String(init?.body);
        return Response.json({ sdp: "answer" });
      },
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  const client = new SessionVoiceClient({
    sessionId: "test-session",
    onState: (state, detail) => states.push([state, detail]),
    onText:
      options?.onText ??
      ((text) => {
        prompts.push(text);
        return true;
      }),
  });
  restores.push(() => client.stop());
  return {
    client,
    stream,
    sent,
    prompts,
    states,
    windowEvents,
    documentEvents,
    emit: (event: TestEvent) =>
      channel.onmessage?.({ data: JSON.stringify(event) }),
    stats: () => ({ stopped, closed, fetches, requestBody }),
  };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("spoken turns use the session send callback exactly once and do not execute tools", async () => {
  const h = setup();
  await h.client.start();
  expect(h.states.at(-1)?.[0]).toBe("listening");
  expect(JSON.parse(h.stats().requestBody)).toEqual({ sdp: "offer" });
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: " Fix the test ",
  });
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: "Fix the test",
  });
  h.emit({
    type: "response.function_call_arguments.done",
    name: "bash",
    arguments: "untrusted",
  });
  await tick();
  expect(h.prompts).toEqual(["Fix the test"]);
  expect(h.sent.some((event) => event.type === "response.create")).toBe(false);
});

test("transcription completion order does not reorder spoken prompts", async () => {
  const h = setup();
  await h.client.start();
  h.emit({ type: "input_audio_buffer.committed", item_id: "first" });
  h.emit({ type: "input_audio_buffer.committed", item_id: "second" });
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "second",
    transcript: "Second",
  });
  expect(h.prompts).toEqual([]);
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "first",
    transcript: "First",
  });
  await tick();
  expect(h.prompts).toEqual(["First", "Second"]);
});

test("agent replies are spoken out of context and barge-in cancels only narration", async () => {
  const h = setup();
  await h.client.start();
  h.client.setAgentBusy(true);
  expect(h.states.at(-1)?.[0]).toBe("working");
  h.client.setAgentBusy(false);
  h.client.speak("Fixed it. Tests passed.");
  const response = h.sent.find(
    (event) => event.type === "response.create",
  )?.response;
  expect(response?.conversation).toBe("none");
  expect(response?.input[0]?.content[0]?.text).toContain(
    "Fixed it. Tests passed.",
  );
  expect(h.states.at(-1)?.[0]).toBe("speaking");
  h.emit({ type: "output_audio_buffer.started" });
  h.emit({ type: "input_audio_buffer.speech_started" });
  expect(h.sent.map((event) => event.type)).toContain("response.cancel");
  expect(h.sent.map((event) => event.type)).toContain(
    "output_audio_buffer.clear",
  );
  expect(h.prompts).toEqual([]);
});

test("permission denial never starts a paid call", async () => {
  const h = setup({ denied: true });
  await h.client.start();
  expect(h.states.at(-1)).toEqual([
    "error",
    "Microphone permission denied. Allow access and try again.",
  ]);
  expect(h.stats().fetches).toBe(0);
});

test("hanging up while permission is pending releases a late microphone", async () => {
  let resolve!: (value: TestMicrophone) => void;
  const h = setup({
    mic: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const start = h.client.start();
  h.client.stop();
  resolve(h.stream);
  await start;
  expect(h.stats().stopped).toBe(1);
  expect(h.stats().fetches).toBe(0);
  expect(h.states.at(-1)?.[0]).toBe("idle");
});

test.each(["pagehide", "opensession-voice-call-start"])(
  "%s releases mic and prevents late sends",
  async (event) => {
    const h = setup();
    await h.client.start();
    h.windowEvents.dispatchEvent(new Event(event));
    h.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "late",
      transcript: "Don't send",
    });
    expect(h.stats().stopped).toBe(1);
    expect(h.stats().closed).toBe(1);
    expect(h.prompts).toEqual([]);
  },
);

test("failed prompt delivery stops the call instead of silently dropping words", async () => {
  const h = setup({ onText: () => false });
  await h.client.start();
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: "Hello",
  });
  await tick();
  expect(h.states.at(-1)?.[0]).toBe("error");
  expect(h.stats().stopped).toBe(1);
});
