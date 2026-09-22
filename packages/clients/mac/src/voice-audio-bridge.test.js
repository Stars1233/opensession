const { describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const {
  VoiceAudioBridge,
  CHANNELS,
  MAX_OUTSTANDING_MIC_PACKETS,
} = require("./voice-audio-bridge");

const ID = "25e5a2a1-65b7-40b5-b0ef-583a2677d595";
const OTHER_ID = "second-session-id-0001";
const APP = "https://acme.example.test";
const options = { inputDeviceId: "", outputDeviceId: "", ducking: true };

class FakeWebContents extends EventEmitter {
  constructor(url = `${APP}/session/abc`) {
    super();
    this.url = url;
    this.destroyed = false;
    this.sent = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  getURL() {
    return this.url;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  navigate(url, { sameDocument = false, mainFrame = true } = {}) {
    this.url = url;
    this.emit("did-start-navigation", {
      isMainFrame: mainFrame,
      isSameDocument: sameDocument,
      url,
    });
  }
}

function eventFor(sender, { url = sender.getURL(), parent = null } = {}) {
  return { sender, senderFrame: { url, parent } };
}

// A controllable stand-in for NativeVoiceAudio.
class FakeNative {
  constructor() {
    this.calls = [];
    this.pending = null;
    this.isAvailable = true;
  }

  available() {
    return this.isAvailable;
  }

  devices() {
    this.calls.push(["devices"]);
    return Promise.resolve({ inputs: [], outputs: [], advancedDucking: true });
  }

  start(id, opts, callbacks) {
    this.calls.push(["start", id, opts]);
    this.callbacks = callbacks;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  ready() {
    this.pending.resolve();
  }

  push(id, samples) {
    this.calls.push(["push", id, samples.length]);
  }

  setPaused(id, paused) {
    this.calls.push(["setPaused", id, paused]);
  }

  clearPlayback(id) {
    this.calls.push(["clearPlayback", id]);
  }

  stop(id) {
    this.calls.push(["stop", id]);
  }

  stopAll() {
    this.calls.push(["stopAll"]);
  }
}

// The permission prompt as a promise the test settles by hand.
function permission() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function harness({ foreground = () => true, mic } = {}) {
  const native = new FakeNative();
  const prompt = mic || permission();
  const bridge = new VoiceAudioBridge({
    native,
    inWindow: (url) => {
      try {
        return new URL(url).origin === APP;
      } catch {
        return false;
      }
    },
    foreground,
    micAccessAllowed: () => prompt.promise,
  });
  return { bridge, native, prompt };
}

async function settled(promise) {
  // Let the awaited permission and native start propagate.
  await Promise.resolve();
  await Promise.resolve();
  return promise;
}

describe("voice audio bridge: who may start", () => {
  test("refuses requests from other origins, iframes and hidden windows", async () => {
    const { bridge, native } = harness({ foreground: () => false });
    const sender = new FakeWebContents();
    await expect(bridge.devices(eventFor(sender))).resolves.toBeDefined();
    await expect(
      bridge.devices(eventFor(sender, { url: "https://evil.example.test/" })),
    ).rejects.toThrow("unavailable");
    await expect(
      bridge.devices(eventFor(sender, { parent: {} })),
    ).rejects.toThrow("unavailable");
    // devices() needs no focus; start() does.
    await expect(bridge.start(eventFor(sender), ID, options)).rejects.toThrow(
      "unavailable",
    );
    expect(native.calls.filter((c) => c[0] === "start")).toHaveLength(0);
  });

  test("validates the request before prompting for the microphone", async () => {
    const { bridge, native } = harness();
    const sender = new FakeWebContents();
    await expect(
      bridge.start(eventFor(sender), "../x", options),
    ).rejects.toThrow("Invalid");
    await expect(
      bridge.start(eventFor(sender), ID, { ...options, ducking: 1 }),
    ).rejects.toThrow("Invalid");
    native.isAvailable = false;
    await expect(bridge.start(eventFor(sender), ID, options)).rejects.toThrow(
      "unavailable",
    );
    expect(bridge.owner).toBeNull();
    expect(native.calls).toEqual([]);
  });

  test("starts the helper for the owner once the microphone is granted", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    expect(bridge.owner?.id).toBe(ID);
    expect(native.calls).toEqual([]);
    prompt.settle(true);
    await settled();
    expect(native.calls).toEqual([["start", ID, options]]);
    native.ready();
    await expect(pending).resolves.toBeUndefined();
    expect(bridge.owner?.started).toBe(true);
  });

  test("a denied microphone releases the owner without native capture", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    prompt.settle(false);
    await expect(pending).rejects.toThrow("denied");
    expect(bridge.owner).toBeNull();
    expect(native.calls).toEqual([["stop", ID]]);
  });
});

describe("voice audio bridge: cancellation while the prompt is up", () => {
  test("stop during the permission prompt cancels the request", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    bridge.stop(eventFor(sender), ID);
    expect(bridge.owner).toBeNull();
    prompt.settle(true);
    await expect(pending).rejects.toThrow("cancelled");
    expect(native.calls.filter((c) => c[0] === "start")).toHaveLength(0);
  });

  test("a main-frame navigation during the prompt cancels the request", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    sender.navigate(`${APP}/session/other`, { sameDocument: true });
    expect(bridge.owner?.id).toBe(ID);
    sender.navigate(`${APP}/session/other`);
    expect(bridge.owner).toBeNull();
    prompt.settle(true);
    await expect(pending).rejects.toThrow("cancelled");
    expect(native.calls.filter((c) => c[0] === "start")).toHaveLength(0);
  });

  test("a renderer crash or destroyed page during the prompt cancels", async () => {
    for (const signal of ["render-process-gone", "destroyed"]) {
      const { bridge, native, prompt } = harness();
      const sender = new FakeWebContents();
      const pending = bridge.start(eventFor(sender), ID, options);
      sender.emit(signal);
      prompt.settle(true);
      await expect(pending).rejects.toThrow("cancelled");
      expect(native.calls.filter((c) => c[0] === "start")).toHaveLength(0);
    }
  });

  test("a newer request replaces the pending owner", async () => {
    const { bridge, native, prompt } = harness();
    const first = new FakeWebContents();
    const second = new FakeWebContents();
    const firstPending = bridge.start(eventFor(first), ID, options);
    const secondPending = bridge.start(eventFor(second), OTHER_ID, options);
    expect(bridge.owner?.id).toBe(OTHER_ID);
    prompt.settle(true);
    await expect(firstPending).rejects.toThrow("cancelled");
    await settled();
    expect(native.calls.filter((c) => c[0] === "start")).toEqual([
      ["start", OTHER_ID, options],
    ]);
    native.ready();
    await expect(secondPending).resolves.toBeUndefined();
    // The old page's messages no longer reach the helper.
    bridge.push(eventFor(first), ID, new Float32Array(2));
    bridge.setPaused(eventFor(first), ID, true);
    expect(native.calls.filter((c) => c[0] === "push")).toHaveLength(0);
  });

  test("a page that left the app while the prompt was up is refused", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    // A URL change without a navigation event (belt and braces).
    sender.url = "https://evil.example.test/";
    prompt.settle(true);
    await expect(pending).rejects.toThrow("unavailable");
    expect(native.calls.filter((c) => c[0] === "start")).toHaveLength(0);
  });

  test("stop during native start still tears the helper down", async () => {
    const { bridge, native, prompt } = harness();
    const sender = new FakeWebContents();
    const pending = bridge.start(eventFor(sender), ID, options);
    prompt.settle(true);
    await settled();
    bridge.stop(eventFor(sender), ID);
    native.ready();
    await expect(pending).rejects.toThrow("cancelled");
    expect(native.calls).toEqual([
      ["start", ID, options],
      ["stop", ID],
    ]);
  });
});

describe("voice audio bridge: a running session", () => {
  async function running(overrides) {
    const h = harness(overrides);
    const sender = new FakeWebContents();
    const pending = h.bridge.start(eventFor(sender), ID, options);
    h.prompt.settle(true);
    await settled();
    h.native.ready();
    await pending;
    return { ...h, sender };
  }

  test("forwards owner messages and ignores everyone else", async () => {
    const { bridge, native, sender } = await running();
    const stranger = new FakeWebContents();
    bridge.push(eventFor(sender), ID, new Float32Array(3));
    bridge.push(eventFor(stranger), ID, new Float32Array(3));
    bridge.push(eventFor(sender), OTHER_ID, new Float32Array(3));
    bridge.push(eventFor(sender, { parent: {} }), ID, new Float32Array(3));
    bridge.setPaused(eventFor(sender), ID, true);
    bridge.setPaused(eventFor(stranger), ID, true);
    bridge.clearPlayback(eventFor(sender), ID);
    bridge.stop(eventFor(stranger), ID);
    expect(bridge.owner?.id).toBe(ID);
    expect(native.calls.slice(1)).toEqual([
      ["push", ID, 3],
      ["setPaused", ID, true],
      ["clearPlayback", ID],
    ]);
  });

  test("acknowledges pushes so the preload can bound them", async () => {
    const { bridge, sender } = await running();
    bridge.push(eventFor(sender), ID, new Float32Array(3));
    bridge.push(eventFor(sender), OTHER_ID, new Float32Array(3));
    expect(sender.sent.map((m) => m.channel)).toEqual([
      CHANNELS.pushAck,
      CHANNELS.pushAck,
    ]);
  });

  test("bounds microphone packets by renderer acknowledgement", async () => {
    const { bridge, native, sender } = await running();
    const samples = new Float32Array(960);
    for (let i = 0; i < MAX_OUTSTANDING_MIC_PACKETS + 3; i += 1)
      native.callbacks.onAudio(samples);
    const delivered = () =>
      sender.sent.filter((m) => m.channel === CHANNELS.audio);
    expect(delivered()).toHaveLength(MAX_OUTSTANDING_MIC_PACKETS);
    expect(bridge.owner.dropped).toBe(3);
    expect(delivered()[0].payload).toEqual({ id: ID, samples });
    bridge.ack(eventFor(sender), ID);
    bridge.ack(eventFor(new FakeWebContents()), ID);
    bridge.ack(eventFor(sender), OTHER_ID);
    native.callbacks.onAudio(samples);
    native.callbacks.onAudio(samples);
    expect(delivered()).toHaveLength(MAX_OUTSTANDING_MIC_PACKETS + 1);
  });

  test("stop releases the owner and the helper; later audio is not delivered", async () => {
    const { bridge, native, sender } = await running();
    bridge.stop(eventFor(sender), ID);
    expect(bridge.owner).toBeNull();
    expect(native.calls.at(-1)).toEqual(["stop", ID]);
    native.callbacks.onAudio(new Float32Array(1));
    native.callbacks.onError("late");
    expect(sender.sent).toEqual([]);
    bridge.stop(eventFor(sender), ID);
    expect(native.calls.filter((c) => c[0] === "stop")).toHaveLength(1);
  });

  test("navigation, crash and close release a running session", async () => {
    const { bridge, native, sender } = await running();
    sender.navigate(`${APP}/session/other`);
    expect(bridge.owner).toBeNull();
    expect(native.calls.at(-1)).toEqual(["stop", ID]);
    native.callbacks.onAudio(new Float32Array(1));
    expect(sender.sent).toEqual([]);
  });

  test("helper errors reach the owner once and end the session", async () => {
    const { bridge, native, sender } = await running();
    native.callbacks.onError("Voice audio failed: device gone");
    native.callbacks.onClose();
    expect(sender.sent).toEqual([
      {
        channel: CHANNELS.error,
        payload: { id: ID, error: "Voice audio failed: device gone" },
      },
    ]);
    expect(bridge.owner).toBeNull();
  });

  test("a replacement tells the running owner why it ended", async () => {
    const { bridge, native, sender } = await running();
    const other = new FakeWebContents();
    const pending = bridge.start(eventFor(other), OTHER_ID, options);
    expect(sender.sent.at(-1)).toEqual({
      channel: CHANNELS.error,
      payload: { id: ID, error: "Replaced by another request." },
    });
    expect(native.calls.at(-1)).toEqual(["stop", ID]);
    bridge.stop(eventFor(other), OTHER_ID);
    await expect(pending).rejects.toThrow("cancelled");
  });

  test("stopAll on quit releases everything", async () => {
    const { bridge, native } = await running();
    bridge.stopAll();
    expect(bridge.owner).toBeNull();
    expect(native.calls.slice(-2)).toEqual([["stop", ID], ["stopAll"]]);
  });
});
