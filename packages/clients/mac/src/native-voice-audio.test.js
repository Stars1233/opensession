const { describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const {
  NativeVoiceAudio,
  FrameParser,
  INBOUND,
  OUTBOUND,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_PENDING_PLAYBACK_BYTES,
  parseDeviceList,
  samplesFromPayload,
  validDeviceId,
  validStartOptions,
} = require("./native-voice-audio");

const ID = "25e5a2a1-65b7-40b5-b0ef-583a2677d595";
const SECOND_ID = "second-session-id-0001";

function frame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function eventFrame(event) {
  return frame(OUTBOUND.event, Buffer.from(JSON.stringify(event)));
}

// A stand-in for the spawned helper: records what the shell writes to stdin
// and lets a test play the helper's side of the protocol.
class FakeChild extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.stdin = new EventEmitter();
    this.stdin.writableLength = 0;
    this.stdin.written = [];
    this.stdin.write = (chunk) => {
      this.stdin.written.push(Buffer.from(chunk));
      return true;
    };
    this.killed = [];
    this.kill = (signal) => {
      this.killed.push(signal);
      return true;
    };
  }

  frames() {
    const parser = new FrameParser();
    return this.stdin.written.flatMap((chunk) => parser.feed(chunk));
  }

  ready() {
    this.stdout.emit("data", eventFrame({ type: "ready" }));
  }

  close(code = 0) {
    this.emit("close", code);
  }
}

function harness({ platform = "darwin", exists = true } = {}) {
  const children = [];
  const timers = [];
  const voice = new NativeVoiceAudio({
    platform,
    exists: () => exists,
    helperPath: () => "/tmp/os1-voice-audio",
    spawn: (_path, args) => {
      const child = new FakeChild(args);
      children.push(child);
      return child;
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  // Fires the timers due at `ms` that exist now; one scheduled by a firing
  // timer waits for the next call, as it would on a real clock.
  const fire = (ms) => {
    for (const timer of [...timers]) {
      if (timer.ms === ms && !timer.cleared) {
        timer.cleared = true;
        timer.fn();
      }
    }
  };
  return { voice, children, timers, fire };
}

const options = { inputDeviceId: "", outputDeviceId: "", ducking: true };

describe("voice audio validation", () => {
  test("device ids are CoreAudio UIDs or empty for the default", () => {
    expect(validDeviceId("")).toBe(true);
    expect(validDeviceId("BuiltInMicrophoneDevice")).toBe(true);
    expect(validDeviceId("AppleUSBAudioEngine:Vendor:Product:1234:2")).toBe(
      true,
    );
    expect(validDeviceId("with space")).toBe(true);
    expect(validDeviceId("a\nb")).toBe(false);
    expect(validDeviceId("x".repeat(257))).toBe(false);
    expect(validDeviceId(42)).toBe(false);
  });

  test("start options need both device ids and a boolean ducking flag", () => {
    expect(validStartOptions(options)).toBe(true);
    expect(validStartOptions({ ...options, ducking: "yes" })).toBe(false);
    expect(validStartOptions({ inputDeviceId: "" })).toBe(false);
    expect(validStartOptions(null)).toBe(false);
  });

  test("device lists are cleaned, deduplicated and capped", () => {
    const list = parseDeviceList(
      JSON.stringify({
        inputs: [
          { id: "mic", label: "  Mic  " },
          { id: "mic", label: "dup" },
          { id: "", label: "default" },
          { id: "nolabel" },
          "junk",
        ],
        outputs: Array.from({ length: 70 }, (_, i) => ({
          id: `out${i}`,
          label: "x".repeat(400),
        })),
        advancedDucking: "true",
      }),
    );
    expect(list.inputs).toEqual([
      { id: "mic", label: "Mic" },
      { id: "nolabel", label: "nolabel" },
    ]);
    expect(list.outputs).toHaveLength(64);
    expect(list.outputs[0].label).toHaveLength(200);
    expect(list.advancedDucking).toBe(false);
    expect(parseDeviceList("not json")).toBeNull();
    expect(parseDeviceList("[]")).toEqual({
      inputs: [],
      outputs: [],
      advancedDucking: false,
    });
  });
});

describe("voice audio frame parser", () => {
  test("reassembles frames split across chunks", () => {
    const parser = new FrameParser();
    const audio = frame(OUTBOUND.audio, Buffer.from([0, 0, 128, 63]));
    const stream = Buffer.concat([audio, eventFrame({ type: "ready" })]);
    const frames = [];
    for (let i = 0; i < stream.length; i += 3)
      frames.push(...parser.feed(stream.subarray(i, i + 3)));
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe(OUTBOUND.audio);
    expect([...samplesFromPayload(frames[0].payload)]).toEqual([1]);
    expect(JSON.parse(frames[1].payload.toString())).toEqual({
      type: "ready",
    });
    expect(parser.failed).toBe(false);
  });

  test("an oversized frame is a protocol failure", () => {
    const parser = new FrameParser();
    const header = Buffer.alloc(5);
    header[0] = OUTBOUND.audio;
    header.writeUInt32LE(MAX_AUDIO_CHUNK_BYTES + 1, 1);
    expect(parser.feed(header)).toEqual([]);
    expect(parser.failed).toBe(true);
  });

  test("sample views copy out of unaligned pipe buffers", () => {
    const backing = Buffer.alloc(9);
    backing.writeFloatLE(0.5, 1);
    backing.writeFloatLE(-1, 5);
    const samples = samplesFromPayload(backing.subarray(1));
    expect(samples).toBeInstanceOf(Float32Array);
    expect([...samples]).toEqual([0.5, -1]);
  });
});

describe("voice audio devices", () => {
  test("is unavailable off macOS or without the packaged helper", async () => {
    await expect(
      harness({ platform: "linux" }).voice.devices(),
    ).rejects.toThrow("unavailable");
    await expect(harness({ exists: false }).voice.devices()).rejects.toThrow(
      "unavailable",
    );
  });

  test("runs the helper in devices mode and parses its answer", async () => {
    const { voice, children } = harness();
    const pending = voice.devices();
    expect(children[0].args).toEqual(["devices"]);
    children[0].stdout.emit(
      "data",
      JSON.stringify({
        inputs: [{ id: "mic", label: "Mic" }],
        outputs: [{ id: "spk", label: "Speakers" }],
        advancedDucking: true,
      }) + "\n",
    );
    children[0].close(0);
    expect(await pending).toEqual({
      inputs: [{ id: "mic", label: "Mic" }],
      outputs: [{ id: "spk", label: "Speakers" }],
      advancedDucking: true,
    });
  });

  test("a helper that hangs is killed and rejected", async () => {
    const { voice, children, fire } = harness();
    const pending = voice.devices();
    fire(5_000);
    await expect(pending).rejects.toThrow("did not respond");
    expect(children[0].killed).toEqual(["SIGTERM"]);
  });

  test("a failing helper rejects", async () => {
    const { voice, children } = harness();
    const pending = voice.devices();
    children[0].close(2);
    await expect(pending).rejects.toThrow("could not be listed");
  });
});

describe("voice audio session", () => {
  test("rejects junk before spawning anything", async () => {
    const { voice, children } = harness();
    await expect(voice.start("../x", options)).rejects.toThrow("Invalid");
    await expect(
      voice.start(ID, { ...options, inputDeviceId: "a\nb" }),
    ).rejects.toThrow("Invalid");
    await expect(
      harness({ platform: "win32" }).voice.start(ID, options),
    ).rejects.toThrow("unavailable");
    expect(children).toHaveLength(0);
  });

  test("passes devices and ducking to the helper and resolves on ready", async () => {
    const { voice, children } = harness();
    const pending = voice.start(ID, {
      inputDeviceId: "mic-uid",
      outputDeviceId: "spk-uid",
      ducking: false,
    });
    expect(children[0].args).toEqual(["stream", "mic-uid", "spk-uid", "0"]);
    children[0].ready();
    await expect(pending).resolves.toBeUndefined();
  });

  test("helper errors before ready reject start and end the session", async () => {
    const { voice, children } = harness();
    const errors = [];
    const closes = [];
    const pending = voice.start(ID, options, {
      onError: (m) => errors.push(m),
      onClose: () => closes.push(1),
    });
    children[0].stdout.emit(
      "data",
      eventFrame({ type: "error", message: "microphone access is denied" }),
    );
    await expect(pending).rejects.toThrow(
      "Voice audio failed: microphone access is denied",
    );
    expect(children[0].killed).toEqual(["SIGTERM"]);
    children[0].close(1);
    expect(errors).toEqual([]);
    expect(closes).toEqual([1]);
    expect(voice.active).toBeNull();
  });

  test("a helper that never becomes ready is killed", async () => {
    const { voice, children, fire } = harness();
    const pending = voice.start(ID, options);
    fire(10_000);
    await expect(pending).rejects.toThrow("did not start in time");
    expect(children[0].killed).toEqual(["SIGTERM"]);
  });

  test("streams microphone frames and agent audio after ready only", async () => {
    const { voice, children } = harness();
    const heard = [];
    const pending = voice.start(ID, options, {
      onAudio: (samples) => heard.push([...samples]),
    });
    const child = children[0];
    voice.push(ID, new Float32Array([1]));
    child.stdout.emit(
      "data",
      frame(OUTBOUND.audio, Buffer.from(new Float32Array([0.5]).buffer)),
    );
    expect(heard).toEqual([]);
    child.ready();
    await pending;
    child.stdout.emit(
      "data",
      frame(OUTBOUND.audio, Buffer.from(new Float32Array([0.5, 0.25]).buffer)),
    );
    expect(heard).toEqual([[0.5, 0.25]]);

    voice.push(ID, new Float32Array([0.125]));
    voice.push(SECOND_ID, new Float32Array([9]));
    voice.push(ID, [0.1]);
    voice.push(ID, new Float32Array(0));
    voice.push(ID, new Float32Array(MAX_AUDIO_CHUNK_BYTES / 4 + 1));
    const frames = child.frames();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(INBOUND.audio);
    expect(frames[0].payload.readFloatLE(0)).toBe(0.125);
  });

  test("drops agent audio when the helper stops reading its pipe", async () => {
    const { voice, children } = harness();
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    children[0].stdin.writableLength = MAX_PENDING_PLAYBACK_BYTES + 1;
    voice.push(ID, new Float32Array([1]));
    expect(children[0].frames()).toHaveLength(0);
  });

  test("pause, resume, clear and stop map to protocol frames", async () => {
    const { voice, children, fire } = harness();
    const closes = [];
    const errors = [];
    const pending = voice.start(ID, options, {
      onClose: () => closes.push(1),
      onError: (m) => errors.push(m),
    });
    const child = children[0];
    child.ready();
    await pending;
    voice.setPaused(ID, true);
    voice.setPaused(ID, false);
    voice.clearPlayback(ID);
    voice.setPaused(SECOND_ID, true);
    voice.stop(ID);
    expect(child.frames().map((f) => f.type)).toEqual([
      INBOUND.pause,
      INBOUND.resume,
      INBOUND.clearPlayback,
      INBOUND.stop,
    ]);
    // The helper exits on its own: nothing is killed and no error is raised.
    child.close(0);
    expect(child.killed).toEqual([]);
    expect(errors).toEqual([]);
    expect(closes).toEqual([1]);
    expect(voice.active).toBeNull();
    fire(1_500);
    expect(child.killed).toEqual([]);
  });

  test("a helper that ignores stop is terminated, then killed", async () => {
    const { voice, children, fire } = harness();
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    voice.stop(ID);
    expect(children[0].killed).toEqual([]);
    fire(1_500);
    expect(children[0].killed).toEqual(["SIGTERM"]);
    fire(1_500);
    expect(children[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a helper that exits after SIGTERM is not SIGKILLed", async () => {
    const { voice, children, fire } = harness();
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    voice.stop(ID);
    fire(1_500);
    children[0].close(0);
    fire(1_500);
    expect(children[0].killed).toEqual(["SIGTERM"]);
  });

  test("stopping a failed helper keeps its kill clock running", async () => {
    const { voice, children, fire } = harness();
    const errors = [];
    const closes = [];
    const pending = voice.start(ID, options, {
      onError: (m) => errors.push(m),
      onClose: () => closes.push(1),
    });
    children[0].ready();
    await pending;
    children[0].stdout.emit(
      "data",
      eventFrame({ type: "error", message: "engine died" }),
    );
    expect(errors).toEqual(["Voice audio failed: engine died"]);
    expect(children[0].killed).toEqual(["SIGTERM"]);
    // The renderer reacts to the error by stopping; the process is still
    // alive, so the session must not be forgotten yet.
    voice.stop(ID);
    expect(closes).toEqual([]);
    expect(voice.active).not.toBeNull();
    fire(1_500);
    expect(children[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
    children[0].close(137);
    expect(closes).toEqual([1]);
    expect(voice.active).toBeNull();
  });

  test("failures and replacements escalate to SIGKILL as well", async () => {
    const { voice, children, fire } = harness();
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    const second = voice.start(SECOND_ID, options);
    expect(children[0].killed).toEqual(["SIGTERM"]);
    fire(1_500);
    expect(children[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
    children[1].ready();
    await second;
    voice.stop(SECOND_ID);
    // Stopping before ready goes straight to termination.
    const third = harness();
    const thirdPending = third.voice.start(ID, options);
    third.voice.stop(ID);
    await expect(thirdPending).rejects.toThrow("stopped");
    expect(third.children[0].killed).toEqual(["SIGTERM"]);
    third.fire(1_500);
    expect(third.children[0].killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("stop for another id or an unknown session is ignored", async () => {
    const { voice, children } = harness();
    voice.stop(ID);
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    voice.stop(SECOND_ID);
    expect(children[0].frames()).toHaveLength(0);
    expect(voice.active.id).toBe(ID);
  });

  test("an unexpected exit or error after ready surfaces through onError once", async () => {
    const { voice, children } = harness();
    const errors = [];
    const pending = voice.start(ID, options, {
      onError: (m) => errors.push(m),
    });
    children[0].ready();
    await pending;
    children[0].stdout.emit(
      "data",
      eventFrame({ type: "error", message: "audio engine could not start" }),
    );
    children[0].close(1);
    expect(errors).toEqual([
      "Voice audio failed: audio engine could not start",
    ]);

    const crash = harness();
    const crashErrors = [];
    const crashPending = crash.voice.start(ID, options, {
      onError: (m) => crashErrors.push(m),
    });
    crash.children[0].ready();
    await crashPending;
    crash.children[0].close(137);
    expect(crashErrors).toEqual(["Native voice audio stopped unexpectedly."]);
    expect(crash.voice.active).toBeNull();
  });

  test("a malformed helper frame ends the session", async () => {
    const { voice, children } = harness();
    const errors = [];
    const pending = voice.start(ID, options, {
      onError: (m) => errors.push(m),
    });
    children[0].ready();
    await pending;
    const header = Buffer.alloc(5);
    header[0] = OUTBOUND.audio;
    header.writeUInt32LE(MAX_AUDIO_CHUNK_BYTES + 1, 1);
    children[0].stdout.emit("data", header);
    expect(errors).toEqual(["Native voice audio sent a malformed frame."]);
    expect(children[0].killed).toEqual(["SIGTERM"]);
  });

  test("only one native voice session exists at a time", async () => {
    const { voice, children } = harness();
    const firstErrors = [];
    const first = voice.start(ID, options, {
      onError: (m) => firstErrors.push(m),
    });
    children[0].ready();
    await first;
    const second = voice.start(SECOND_ID, options);
    expect(children[0].killed).toEqual(["SIGTERM"]);
    expect(firstErrors).toEqual(["Replaced by another voice session."]);
    children[1].ready();
    await second;
    expect(voice.active.id).toBe(SECOND_ID);
    // The replaced helper is ignored even before it exits.
    children[0].stdout.emit(
      "data",
      frame(OUTBOUND.audio, Buffer.from(new Float32Array([1]).buffer)),
    );
    voice.push(ID, new Float32Array([1]));
    expect(children[0].frames()).toHaveLength(0);
    children[0].close(0);
    expect(voice.active.id).toBe(SECOND_ID);
  });

  test("stopAll on quit releases the session once", async () => {
    const { voice, children } = harness();
    const pending = voice.start(ID, options);
    children[0].ready();
    await pending;
    voice.stopAll();
    voice.stopAll();
    expect(children[0].frames().map((f) => f.type)).toEqual([INBOUND.stop]);
  });
});
