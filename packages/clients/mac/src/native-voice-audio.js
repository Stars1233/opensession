// Main-process side of window.os1.voiceAudio: one signed native helper
// (native/VoiceAudioHelper.swift) owns the microphone and speaker for a
// realtime voice session. The renderer only ever sees 48 kHz mono Float32 PCM
// in both directions; device choice, echo cancellation and other-audio ducking
// live in the helper. Exactly one voice session exists at a time.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { commandFrame, validID } = require("./native-dictation");

const START_TIMEOUT_MS = 10_000;
// After a stop frame the helper gets this long to exit on its own, then
// SIGTERM, then this long again before SIGKILL. The microphone is released
// by the helper's own teardown or by the kernel, never left to chance.
const STOP_TIMEOUT_MS = 1_500;
const KILL_TIMEOUT_MS = 1_500;
const DEVICES_TIMEOUT_MS = 5_000;
// One pushed chunk of agent audio, and one microphone frame from the helper.
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
// Agent audio still sitting in this process's stdin buffer for the helper:
// 250 ms of 48 kHz mono. The helper reads eagerly and keeps its own 250 ms
// ring, so anything queued here means the helper is stalled; further chunks
// are dropped, not buffered.
const MAX_PENDING_PLAYBACK_BYTES = 48_000;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_DEVICE_LABEL_LENGTH = 200;
const MAX_DEVICES = 64;
const MAX_DEVICE_LIST_BYTES = 64 * 1024;

const INBOUND = { audio: 1, stop: 2, pause: 3, resume: 4, clearPlayback: 5 };
const OUTBOUND = { audio: 1, event: 2 };

function defaultHelperPath() {
  return path.join(process.resourcesPath, "os1-voice-audio");
}

// A CoreAudio UID is free-form text; the empty string selects the default
// device. Control characters never appear in one and would only serve as
// argument smuggling, so they are refused.
function validDeviceId(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_DEVICE_ID_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(value)
  );
}

function validStartOptions(options) {
  return (
    !!options &&
    typeof options === "object" &&
    validDeviceId(options.inputDeviceId) &&
    validDeviceId(options.outputDeviceId) &&
    typeof options.ducking === "boolean"
  );
}

// Incremental decoder for the helper's [type u8][length u32le][payload]
// stream. `failed` flips on an oversized frame, which is a protocol
// violation rather than something to recover from.
class FrameParser {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.failed = false;
  }

  feed(chunk) {
    if (this.failed) return [];
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames = [];
    while (this.pending.length >= 5) {
      const type = this.pending[0];
      const length = this.pending.readUInt32LE(1);
      if (length > MAX_AUDIO_CHUNK_BYTES) {
        this.failed = true;
        this.pending = Buffer.alloc(0);
        return frames;
      }
      if (this.pending.length < 5 + length) break;
      frames.push({ type, payload: this.pending.subarray(5, 5 + length) });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }
}

// Float32 view over a copy of the payload: pipe buffers are not guaranteed to
// be 4-byte aligned, and the renderer must not share memory with the parser.
function samplesFromPayload(payload) {
  const samples = new Float32Array(Math.floor(payload.byteLength / 4));
  Buffer.from(samples.buffer).set(payload.subarray(0, samples.byteLength));
  return samples;
}

function cleanDevices(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const devices = [];
  for (const entry of list) {
    if (devices.length >= MAX_DEVICES) break;
    if (
      !entry ||
      typeof entry !== "object" ||
      !validDeviceId(entry.id) ||
      entry.id === "" ||
      seen.has(entry.id)
    )
      continue;
    seen.add(entry.id);
    const label =
      typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, MAX_DEVICE_LABEL_LENGTH)
        : entry.id;
    devices.push({ id: entry.id, label });
  }
  return devices;
}

function parseDeviceList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return {
    inputs: cleanDevices(parsed.inputs),
    outputs: cleanDevices(parsed.outputs),
    advancedDucking: parsed.advancedDucking === true,
  };
}

class NativeVoiceAudio {
  constructor({
    spawn = childProcess.spawn,
    helperPath = defaultHelperPath,
    platform = process.platform,
    exists = fs.existsSync,
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
  } = {}) {
    this.spawn = spawn;
    this.helperPath = helperPath;
    this.platform = platform;
    this.exists = exists;
    this.schedule = schedule;
    this.cancel = cancel;
    this.active = null;
  }

  available() {
    return this.platform === "darwin" && this.exists(this.helperPath());
  }

  launch(args) {
    const child = this.spawn(this.helperPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A helper that already exited makes later writes fail asynchronously;
    // those are teardown noise, not something to crash the shell over.
    child.stdin.on("error", () => {});
    return child;
  }

  devices() {
    if (!this.available())
      return Promise.reject(new Error("Native voice audio is unavailable."));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.launch(["devices"]);
      } catch (error) {
        reject(new Error("Native voice audio could not start."));
        return;
      }
      let stdout = "";
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        fn(value);
      };
      const timer = this.schedule(() => {
        child.kill("SIGTERM");
        settle(reject, new Error("Audio devices did not respond."));
      }, DEVICES_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_DEVICE_LIST_BYTES) {
          child.kill("SIGTERM");
          settle(reject, new Error("Audio device list was too large."));
        }
      });
      child.stderr.on("data", () => {});
      child.on("error", () =>
        settle(reject, new Error("Native voice audio could not start.")),
      );
      child.on("close", (code) => {
        const list = code === 0 ? parseDeviceList(stdout) : null;
        if (list) settle(resolve, list);
        else settle(reject, new Error("Audio devices could not be listed."));
      });
    });
  }

  // Resolves once the helper reports its engine running. `callbacks.onAudio`
  // receives 48 kHz mono Float32Array microphone frames, `onError` a message
  // when the session ends for a reason other than stop(), and `onClose` fires
  // exactly once when the helper is gone, whatever the reason.
  start(id, options, callbacks = {}) {
    if (!validID(id) || !validStartOptions(options))
      return Promise.reject(new Error("Invalid voice audio request."));
    if (!this.available())
      return Promise.reject(new Error("Native voice audio is unavailable."));
    if (this.active)
      this.fail(this.active, "Replaced by another voice session.");

    let child;
    try {
      child = this.launch([
        "stream",
        options.inputDeviceId,
        options.outputDeviceId,
        options.ducking ? "1" : "0",
      ]);
    } catch (error) {
      console.error("[voice-audio] native helper could not start", error);
      return Promise.reject(new Error("Native voice audio could not start."));
    }

    const entry = {
      id,
      child,
      parser: new FrameParser(),
      ready: false,
      stopping: false,
      closed: false,
      failed: false,
      stderr: "",
      startResolve: null,
      startReject: null,
      startTimer: null,
      stopTimer: null,
      killTimer: null,
      droppedPushes: 0,
      onAudio: callbacks.onAudio || (() => {}),
      onError: callbacks.onError || (() => {}),
      onClose: callbacks.onClose || (() => {}),
    };
    this.active = entry;

    child.stdout.on("data", (chunk) => {
      if (entry.closed) return;
      const frames = entry.parser.feed(chunk);
      for (const frame of frames) {
        if (frame.type === OUTBOUND.audio) {
          if (entry.ready && !entry.stopping)
            entry.onAudio(samplesFromPayload(frame.payload));
        } else if (frame.type === OUTBOUND.event) {
          this.handleEvent(entry, frame.payload);
        }
      }
      if (entry.parser.failed)
        this.fail(entry, "Native voice audio sent a malformed frame.");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      entry.stderr = (entry.stderr + chunk).slice(-2_000);
    });
    child.on("error", (error) => {
      console.error("[voice-audio] native helper failed", error);
      this.fail(entry, "Native voice audio could not start.");
    });
    child.on("close", (code) => {
      entry.closed = true;
      if (code && !entry.failed && !entry.stopping) {
        console.error(
          `[voice-audio] native helper exited ${code}: ${entry.stderr}`,
        );
      }
      if (!entry.failed && !entry.stopping)
        this.fail(entry, "Native voice audio stopped unexpectedly.");
      this.clear(entry);
    });

    return new Promise((resolve, reject) => {
      entry.startResolve = resolve;
      entry.startReject = reject;
      entry.startTimer = this.schedule(() => {
        this.fail(entry, "Native voice audio did not start in time.");
      }, START_TIMEOUT_MS);
    });
  }

  handleEvent(entry, payload) {
    let event;
    try {
      event = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    if (event.type === "ready") {
      if (entry.ready) return;
      entry.ready = true;
      this.settleStart(entry);
    } else if (event.type === "error") {
      const message =
        typeof event.message === "string" && event.message.trim()
          ? `Voice audio failed: ${event.message.trim()}`
          : "Voice audio failed.";
      this.fail(entry, message);
    }
  }

  settleStart(entry, error) {
    if (entry.startTimer) this.cancel(entry.startTimer);
    entry.startTimer = null;
    const resolve = entry.startResolve;
    const reject = entry.startReject;
    entry.startResolve = null;
    entry.startReject = null;
    if (!resolve) return;
    if (error) reject(new Error(error));
    else resolve();
  }

  // The session is over for a reason the renderer did not ask for. Before
  // `ready` that is the start() rejection; afterwards it is an onError.
  fail(entry, message) {
    if (entry.failed || entry.stopping) {
      this.settleStart(entry, message);
      return;
    }
    entry.failed = true;
    if (entry.startResolve) this.settleStart(entry, message);
    else entry.onError(message);
    this.terminate(entry);
  }

  // SIGTERM lets the helper run its own teardown; a helper that is still
  // alive afterwards (wedged on a full pipe, say) is SIGKILLed. The kernel
  // then closes its audio session, so the microphone comes back either way.
  terminate(entry) {
    if (entry.closed) {
      this.clear(entry);
      return;
    }
    if (entry.killTimer) return;
    entry.child.kill("SIGTERM");
    entry.killTimer = this.schedule(() => {
      entry.killTimer = null;
      if (!entry.closed) entry.child.kill("SIGKILL");
    }, KILL_TIMEOUT_MS);
  }

  push(id, samples) {
    const entry = this.active;
    if (
      !entry ||
      entry.id !== id ||
      !entry.ready ||
      entry.stopping ||
      entry.closed ||
      entry.failed
    )
      return;
    if (
      !(samples instanceof Float32Array) ||
      samples.byteLength === 0 ||
      samples.byteLength > MAX_AUDIO_CHUNK_BYTES
    )
      return;
    if (entry.child.stdin.writableLength > MAX_PENDING_PLAYBACK_BYTES) {
      entry.droppedPushes += 1;
      if (entry.droppedPushes === 1 || entry.droppedPushes % 100 === 0)
        console.warn(
          `[voice-audio] playback is too far ahead, dropped ${entry.droppedPushes} chunks`,
        );
      return;
    }
    entry.child.stdin.write(commandFrame(INBOUND.audio, samples));
  }

  send(id, type) {
    const entry = this.active;
    if (
      !entry ||
      entry.id !== id ||
      !entry.ready ||
      entry.stopping ||
      entry.closed ||
      entry.failed
    )
      return false;
    entry.child.stdin.write(commandFrame(type));
    return true;
  }

  setPaused(id, paused) {
    this.send(id, paused ? INBOUND.pause : INBOUND.resume);
  }

  clearPlayback(id) {
    this.send(id, INBOUND.clearPlayback);
  }

  // Asks the helper to release the hardware and exit; a helper that does not
  // go on its own is killed. Safe to call for an id that is already gone.
  stop(id) {
    const entry = this.active;
    if (!entry || (id && entry.id !== id)) return;
    if (entry.stopping) return;
    entry.stopping = true;
    this.settleStart(entry, "Voice audio was stopped.");
    if (entry.closed) {
      this.clear(entry);
      return;
    }
    // A failed helper is already on its SIGTERM/SIGKILL clock; that clock
    // keeps running until the process is really gone.
    if (entry.failed || !entry.ready) {
      this.terminate(entry);
      return;
    }
    entry.child.stdin.write(commandFrame(INBOUND.stop));
    entry.stopTimer = this.schedule(() => {
      entry.stopTimer = null;
      this.terminate(entry);
    }, STOP_TIMEOUT_MS);
  }

  stopAll() {
    this.stop();
  }

  clear(entry) {
    for (const timer of ["stopTimer", "startTimer", "killTimer"]) {
      if (entry[timer]) this.cancel(entry[timer]);
      entry[timer] = null;
    }
    if (this.active === entry) this.active = null;
    if (!entry.notifiedClose) {
      entry.notifiedClose = true;
      entry.onClose();
    }
  }
}

module.exports = {
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
};
