import { afterEach, expect, test } from "bun:test";
import { NativeVoiceAudio } from "./native-voice-audio";
import type { NativeVoiceAudioBridge } from "./os1-shell";

interface TestPacket {
  type: string;
  epoch?: number;
  paused?: boolean;
  samples?: Float32Array;
}

interface TestState {
  stopped: string[];
  started: Array<{
    id: string;
    settings: Parameters<NativeVoiceAudioBridge["start"]>[1];
  }>;
  pushed: Float32Array[];
  paused: boolean[];
  cleared: number;
  closed: number;
  trackStopped: number;
  unsubscribed: number;
  errors: string[];
  outputAttached: number;
  contextOptions: AudioContextOptions & { sinkId?: { type: string } };
  workletOptions: AudioWorkletNodeOptions;
}
interface TestPort {
  onmessage: ((event: { data: TestPacket }) => void) | null;
  postMessage(data: TestPacket): void;
  close(): void;
}

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  options: { start?: () => Promise<void>; module?: Promise<void> } = {},
) {
  const state: TestState = {
    stopped: [],
    started: [],
    pushed: [],
    paused: [],
    cleared: 0,
    closed: 0,
    trackStopped: 0,
    unsubscribed: 0,
    errors: [],
    outputAttached: 0,
    contextOptions: {},
    workletOptions: {},
  };
  let onAudio: Parameters<NativeVoiceAudioBridge["onAudio"]>[0] = () => {};
  let onError: Parameters<NativeVoiceAudioBridge["onError"]>[0] = () => {};
  const api: NativeVoiceAudioBridge = {
    devices: async () => ({ inputs: [], outputs: [], advancedDucking: true }),
    start: async (id, settings) => {
      state.started.push({ id, settings });
      await options.start?.();
    },
    push: (_id, samples) => {
      state.pushed.push(samples);
    },
    stop: (id) => {
      state.stopped.push(id);
    },
    clearPlayback: () => {
      state.cleared++;
    },
    setPaused: (_id, paused) => {
      state.paused.push(paused);
    },
    onAudio: (callback) => {
      onAudio = callback;
      return () => {
        state.unsubscribed++;
      };
    },
    onError: (callback) => {
      onError = callback;
      return () => {
        state.unsubscribed++;
      };
    },
  };
  const posted: Array<{ type: string; epoch?: number; paused?: boolean }> = [];
  const port: TestPort = {
    onmessage: null,
    postMessage: (data: { type: string }) => posted.push(data),
    close() {},
  };
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          state.trackStopped++;
        },
      },
    ],
  };
  const destination = { stream };
  install("AudioContext", {
    value: class {
      constructor(options: AudioContextOptions) {
        state.contextOptions = options;
      }
      destination = {};
      audioWorklet = { addModule: () => options.module ?? Promise.resolve() };
      resume = async () => {};
      close = async () => {
        state.closed++;
      };
      createMediaStreamDestination = () => destination;
      createMediaStreamSource = () => {
        state.outputAttached++;
        return { connect() {}, disconnect() {} };
      };
    },
  });
  install("AudioWorkletNode", {
    value: class {
      constructor(
        _context: AudioContext,
        _name: string,
        options: AudioWorkletNodeOptions,
      ) {
        state.workletOptions = options;
      }
      port = port;
      connect() {}
      disconnect() {}
    },
  });
  const audio = new NativeVoiceAudio(api, (message) =>
    state.errors.push(message),
  );
  restores.push(() => audio.stop());
  return {
    audio,
    state,
    port,
    posted,
    stream,
    mic: (samples = new Float32Array(960), id = state.started[0].id) =>
      onAudio({ id, samples }),
    error: (error: string, id = state.started[0].id) => onError({ id, error }),
    playback: (epoch: number) =>
      port.onmessage?.({
        data: { type: "playback", samples: new Float32Array(960), epoch },
      }),
  };
}

test("native transport uses a silent 48k sink and mono WebRTC stream, routes output only to helper", async () => {
  const h = setup();
  const stream = await h.audio.start();
  expect(stream.getTracks()).toHaveLength(1);
  expect(h.state.contextOptions).toEqual({
    sampleRate: 48000,
    sinkId: { type: "none" },
  });
  expect(h.state.workletOptions).toMatchObject({
    channelCount: 1,
    channelCountMode: "explicit",
  });
  h.audio.attachOutput(stream);
  h.playback(0);
  expect(h.state.outputAttached).toBe(1);
  expect(h.state.pushed.length).toBe(1);
  expect(h.posted.at(-1)?.type).toBe("playback-ack");
});

test("mic flow is owner-filtered and bounded while worklet is stalled", async () => {
  const h = setup();
  await h.audio.start();
  h.mic(new Float32Array(960), "other-call");
  expect(h.posted.length).toBe(0);
  for (let i = 0; i < 20; i++) h.mic();
  expect(h.posted.length).toBe(8);
  h.port.onmessage?.({ data: { type: "mic-ack" } });
  h.mic();
  expect(h.posted.length).toBe(9);
});

test("pause and interruptions reject stale playback and propagate to native engine", async () => {
  const h = setup();
  await h.audio.start();
  h.audio.setPaused(true);
  h.playback(0);
  h.mic();
  expect(h.state.pushed.length).toBe(0);
  expect(h.posted.filter((p) => p.type === "mic").length).toBe(0);
  h.audio.setPaused(false);
  h.playback(0);
  h.playback(2);
  expect(h.state.pushed.length).toBe(1);
  expect(h.state.paused).toEqual([true, false]);
  h.audio.clearPlayback();
  h.playback(2);
  expect(h.state.cleared).toBe(1);
  expect(h.state.pushed.length).toBe(1);
  h.playback(3);
  expect(h.state.pushed.length).toBe(2);
});

test("native errors stop capture, listeners and context exactly once; foreign errors ignored", async () => {
  const h = setup();
  await h.audio.start();
  h.error("Foreign", "other-call");
  expect(h.state.closed).toBe(0);
  h.error("Device disconnected");
  h.error("Again");
  h.audio.stop();
  expect(h.state.errors).toEqual(["Device disconnected"]);
  expect(h.state.closed).toBe(1);
  expect(h.state.trackStopped).toBe(1);
  expect(h.state.unsubscribed).toBe(2);
  expect(h.state.stopped.length).toBe(1);
});

test("cancellation while loading worklet never opens native microphone", async () => {
  const module = deferred();
  const h = setup({ module: module.promise });
  const starting = h.audio.start();
  await Promise.resolve();
  h.audio.stop();
  module.resolve();
  await expect(starting).rejects.toThrow("Call cancelled");
  expect(h.state.started.length).toBe(0);
  expect(h.state.closed).toBe(1);
});

test("cancellation during permission prompt stops a late native start", async () => {
  const permission = deferred();
  const entered = deferred();
  const h = setup({
    start: () => {
      entered.resolve();
      return permission.promise;
    },
  });
  const starting = h.audio.start();
  await entered.promise;
  h.audio.stop();
  permission.resolve();
  await expect(starting).rejects.toThrow("Call cancelled");
  expect(h.state.stopped).toEqual([
    h.state.started[0].id,
    h.state.started[0].id,
  ]);
  expect(h.state.closed).toBe(1);
});

test("native startup failure cleans up and never falls back to a different microphone", async () => {
  const h = setup({
    start: async () => {
      throw new Error("Selected microphone disconnected");
    },
  });
  await expect(h.audio.start()).rejects.toThrow(
    "Selected microphone disconnected",
  );
  expect(h.state.closed).toBe(1);
  expect(h.state.stopped.length).toBe(1);
  expect(h.state.unsubscribed).toBe(2);
});
