import { afterEach, expect, spyOn, test } from "bun:test";
import { DictationAudio } from "./dictation-audio";
import { NativeVoiceAudio } from "./native-voice-audio";

interface TestTrack {
  stop(): void;
  onended: (() => void) | null;
}

const restores: Array<() => void> = [];
function install(name: string, replacement: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    ...replacement,
  });
  restores.push(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function setup(native: boolean) {
  let stopped = 0;
  let browserCaptures = 0;
  const errors: string[] = [];
  const track: TestTrack = {
    stop() {
      stopped++;
    },
    onended: null,
  };
  install("MediaStream", {
    value: class {
      getTracks() {
        return [track];
      }
    },
  });
  const stream = new MediaStream();
  install("window", {
    value: { os1: native ? { voiceAudio: {} } : undefined },
  });
  install("navigator", {
    value: {
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          browserCaptures++;
          expect(constraints).toEqual({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          return stream;
        },
      },
    },
  });
  const startNative = spyOn(
    NativeVoiceAudio.prototype,
    "start",
  ).mockResolvedValue(stream);
  const stopNative = spyOn(
    NativeVoiceAudio.prototype,
    "stop",
  ).mockImplementation(() => {});
  restores.push(() => {
    startNative.mockRestore();
    stopNative.mockRestore();
  });
  const capture = new DictationAudio((message) => errors.push(message));
  restores.push(() => capture.stop());
  return {
    capture,
    stream,
    track,
    startNative,
    stopNative,
    errors,
    get stopped() {
      return stopped;
    },
    get browserCaptures() {
      return browserCaptures;
    },
  };
}

test("dictation uses the native device/ducking transport without browser capture", async () => {
  const h = setup(true);
  expect(await h.capture.start()).toBe(h.stream);
  expect(h.startNative).toHaveBeenCalledTimes(1);
  expect(h.browserCaptures).toBe(0);
  h.capture.stop();
  h.capture.stop();
  expect(h.stopNative).toHaveBeenCalledTimes(1);
  expect(h.track.onended).toBeNull();
});

test("older shells and browsers retain the processed browser microphone", async () => {
  const h = setup(false);
  expect(await h.capture.start()).toBe(h.stream);
  expect(h.browserCaptures).toBe(1);
  expect(h.startNative).not.toHaveBeenCalled();
  h.capture.stop();
  expect(h.stopped).toBe(1);
});

test("a disconnected input ends capture once, not a silent switch of microphone", async () => {
  const h = setup(true);
  await h.capture.start();
  const ended = h.track.onended;
  ended?.();
  ended?.();
  expect(h.errors).toEqual(["The microphone disconnected."]);
  expect(h.stopNative).toHaveBeenCalledTimes(1);
  expect(h.browserCaptures).toBe(0);
});

test("a native startup failure releases the helper and does not fall back", async () => {
  const h = setup(true);
  h.startNative.mockRejectedValue(
    new Error("Selected microphone is unavailable"),
  );
  await expect(h.capture.start()).rejects.toThrow(
    "Selected microphone is unavailable",
  );
  expect(h.stopNative).toHaveBeenCalledTimes(1);
  expect(h.browserCaptures).toBe(0);
});

test("cancellation during the native permission prompt releases a late stream", async () => {
  const h = setup(true);
  let allow!: (stream: MediaStream) => void;
  h.startNative.mockImplementation(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const starting = h.capture.start();
  h.capture.stop();
  expect(h.stopNative).toHaveBeenCalledTimes(1);
  allow(h.stream);
  await expect(starting).rejects.toThrow("Dictation cancelled");
  expect(h.stopped).toBe(1);
  expect(h.errors).toEqual([]);
});

test("stopped capture cannot reopen a microphone", async () => {
  const h = setup(true);
  h.capture.stop();
  await expect(h.capture.start()).rejects.toThrow("Dictation cancelled");
  expect(h.startNative).not.toHaveBeenCalled();
});

test("cancellation also releases a late browser microphone permission grant", async () => {
  const h = setup(false);
  const permission = Promise.withResolvers<MediaStream>();
  const getUserMedia = spyOn(
    navigator.mediaDevices,
    "getUserMedia",
  ).mockReturnValue(permission.promise);
  try {
    const starting = h.capture.start();
    h.capture.stop();
    permission.resolve(h.stream);
    await expect(starting).rejects.toThrow("Dictation cancelled");
    expect(h.stopped).toBe(1);
    expect(h.track.onended).toBeNull();
  } finally {
    getUserMedia.mockRestore();
  }
});
