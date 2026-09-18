import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { SessionVoiceAgentRequest } from "../../shared/session-voice";
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
  call_id?: string;
}
const commandSchema = z.object({
  type: z.string(),
  item: z
    .object({
      type: z.string(),
      call_id: z.string().optional(),
      output: z.string().optional(),
      content: z.array(z.object({ text: z.string() })).optional(),
    })
    .optional(),
  session: z.object({ instructions: z.string() }).optional(),
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
  const proposals: SessionVoiceAgentRequest[] = [];
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
    context: "Initial thread",
    onRequest: (request) => proposals.push(request),
  });
  restores.push(() => client.stop());
  return {
    client,
    stream,
    sent,
    proposals,
    states,
    windowEvents,
    documentEvents,
    emit: (event: TestEvent) =>
      channel.onmessage?.({ data: JSON.stringify(event) }),
    stats: () => ({ stopped, closed, fetches, requestBody }),
  };
}

function propose(h: ReturnType<typeof setup>, callId = "request-one") {
  h.emit({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name: "request_agent_help",
    arguments: JSON.stringify({
      prompt: "Check the current CI failure",
      reason: "The transcript does not include current CI",
      approved: true,
    }),
  });
}

test("spoken questions stay in the voice conversation, with no thread messages", async () => {
  const h = setup();
  await h.client.start();
  h.emit({ type: "input_audio_buffer.speech_started" });
  h.emit({ type: "input_audio_buffer.speech_stopped" });
  h.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "one",
    transcript: "Why did it change that?",
  });
  h.emit({ type: "response.created" });
  h.emit({ type: "output_audio_buffer.started" });
  h.emit({ type: "response.done", response: { status: "completed" } });
  h.emit({ type: "output_audio_buffer.stopped" });
  expect(h.proposals).toEqual([]);
  expect(h.sent).toEqual([]);
  expect(h.states.at(-1)?.[0]).toBe("listening");
});

test("model requests only propose work; claimed approval cannot send it", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  propose(h);
  expect(h.proposals).toHaveLength(1);
  expect(h.sent).toEqual([]);
  let sends = 0;
  const submit = () => {
    sends++;
    return true;
  };
  expect(await h.client.resolveAgentRequest("wrong-id", true, submit)).toBe(
    false,
  );
  expect(sends).toBe(0);
  expect(await h.client.resolveAgentRequest("request-one", true, submit)).toBe(
    true,
  );
  expect(sends).toBe(1);
  expect(await h.client.resolveAgentRequest("request-one", true, submit)).toBe(
    false,
  );
  expect(sends).toBe(1);
  expect(h.sent[0]?.item?.output).toContain("normal queue");
});

test("declining a request never sends a prompt", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  let sends = 0;
  expect(
    await h.client.resolveAgentRequest("request-one", false, () => {
      sends++;
      return true;
    }),
  ).toBe(false);
  expect(sends).toBe(0);
  expect(h.sent[0]?.item?.output).toContain("declined");
});

test("tool calls cannot bypass the proposal gate or overlap approved work", async () => {
  const h = setup();
  await h.client.start();
  h.emit({
    type: "response.function_call_arguments.done",
    call_id: "bash",
    name: "bash",
    arguments: "{}",
  });
  expect(h.proposals).toEqual([]);
  propose(h);
  await h.client.resolveAgentRequest("request-one", true, () => true);
  propose(h, "request-two");
  expect(h.proposals).toHaveLength(1);
  expect(h.sent.at(-1)?.item?.output).toContain("Only one");
});

test("fresh thread context updates the voice context without speaking or posting", async () => {
  const h = setup();
  await h.client.start();
  h.client.updateContext("Initial thread");
  expect(h.sent).toEqual([]);
  h.client.updateContext("New agent reply in thread");
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.session?.instructions).toContain(
    "New agent reply in thread",
  );
  expect(h.sent[0]?.type).toBe("session.update");
});

test("approved agent results return to the voice discussion", async () => {
  const h = setup();
  await h.client.start();
  h.client.agentReply("Unsolicited reply");
  expect(h.sent).toEqual([]);
  propose(h);
  await h.client.resolveAgentRequest("request-one", true, () => true);
  h.emit({ type: "response.done", response: { status: "completed" } });
  h.client.agentReply("CI passes now");
  expect(
    h.sent.find((event) => event.item?.type === "message")?.item?.content?.[0]
      ?.text,
  ).toContain("CI passes now");
});

test("barge-in stops speech without starting or stopping the agent", async () => {
  const h = setup();
  await h.client.start();
  h.emit({ type: "response.created" });
  h.emit({ type: "output_audio_buffer.started" });
  h.emit({ type: "input_audio_buffer.speech_started" });
  expect(h.sent.map((event) => event.type)).toEqual([
    "response.cancel",
    "output_audio_buffer.clear",
  ]);
  expect(h.proposals).toEqual([]);
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
    expect(h.proposals).toEqual([]);
  },
);

test("failed approved delivery is reported honestly to the voice companion", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  expect(
    await h.client.resolveAgentRequest("request-one", true, () => false),
  ).toBe(false);
  expect(h.sent[0]?.item?.output).toContain("could not be sent");
});

test("hanging up revokes pending agent approval", async () => {
  const h = setup();
  await h.client.start();
  propose(h);
  h.client.stop();
  let sends = 0;
  expect(
    await h.client.resolveAgentRequest("request-one", true, () => {
      sends++;
      return true;
    }),
  ).toBe(false);
  expect(sends).toBe(0);
});
