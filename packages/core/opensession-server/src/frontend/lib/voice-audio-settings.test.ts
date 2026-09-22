import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
let setItemFailure: Error | null = null;
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (setItemFailure) throw setItemFailure;
      store.set(key, value);
    },
    removeItem: (key: string) => void store.delete(key),
  },
});

let settings: typeof import("./voice-audio-settings");

beforeAll(async () => {
  settings = await import("./voice-audio-settings");
});
beforeEach(() => {
  // A write storage accepts clears any choice a failed one left in memory.
  setItemFailure = null;
  settings.writeVoiceAudioSettings(settings.DEFAULT_VOICE_AUDIO_SETTINGS);
  store.clear();
});

const KEY = "opensession:voice-audio:v1";

describe("voice audio settings", () => {
  test("defaults to the system devices with ducking on", () => {
    expect(settings.readVoiceAudioSettings()).toEqual({
      inputDeviceId: "",
      outputDeviceId: "",
      ducking: true,
    });
  });

  test("round-trips a written value under the versioned key", () => {
    settings.writeVoiceAudioSettings({
      inputDeviceId: "BuiltInMicrophoneDevice",
      outputDeviceId: "bt-headphones",
      ducking: false,
    });
    expect(JSON.parse(store.get(KEY)!)).toEqual({
      inputDeviceId: "BuiltInMicrophoneDevice",
      outputDeviceId: "bt-headphones",
      ducking: false,
    });
    expect(settings.readVoiceAudioSettings()).toEqual({
      inputDeviceId: "BuiltInMicrophoneDevice",
      outputDeviceId: "bt-headphones",
      ducking: false,
    });
  });

  test("writes only the three known fields", () => {
    // A caller handing over a wider object must not leak extra keys into
    // storage, where a later parser would have to tolerate them.
    const wide = {
      inputDeviceId: "mic",
      outputDeviceId: "",
      ducking: true,
      extra: "not stored",
    };
    expect(settings.writeVoiceAudioSettings(wide)).toBe(true);
    expect(Object.keys(JSON.parse(store.get(KEY)!)).sort()).toEqual([
      "ducking",
      "inputDeviceId",
      "outputDeviceId",
    ]);
  });

  test("falls back per field when storage holds a partial or wrong shape", () => {
    store.set(KEY, JSON.stringify({ inputDeviceId: "mic" }));
    expect(settings.readVoiceAudioSettings()).toEqual({
      inputDeviceId: "mic",
      outputDeviceId: "",
      ducking: true,
    });
    store.set(
      KEY,
      JSON.stringify({ inputDeviceId: 3, outputDeviceId: null, ducking: "no" }),
    );
    expect(settings.readVoiceAudioSettings()).toEqual({
      inputDeviceId: "",
      outputDeviceId: "",
      ducking: true,
    });
  });

  test("treats malformed JSON, non-objects and empty strings as defaults", () => {
    for (const raw of ["{not json", "42", "null", "[]", "", '"mic"']) {
      store.set(KEY, raw);
      expect(settings.readVoiceAudioSettings()).toEqual({
        inputDeviceId: "",
        outputDeviceId: "",
        ducking: true,
      });
    }
    expect(settings.parseVoiceAudioSettings(null)).toEqual({
      inputDeviceId: "",
      outputDeviceId: "",
      ducking: true,
    });
  });

  test("a failing store never throws, and the choice still reaches the next call", () => {
    setItemFailure = new Error("QuotaExceededError");
    let persisted: boolean | undefined;
    expect(() => {
      persisted = settings.writeVoiceAudioSettings({
        inputDeviceId: "BuiltInMicrophoneDevice",
        outputDeviceId: "",
        ducking: true,
      });
    }).not.toThrow();
    expect(persisted).toBe(false);
    expect(store.has(KEY)).toBe(false);
    // The transport reads through the same function, so the unsaved choice
    // is what the next call in this window uses, never a silent fall back
    // to whatever microphone the system default happens to be.
    expect(settings.readVoiceAudioSettings().inputDeviceId).toBe(
      "BuiltInMicrophoneDevice",
    );
  });

  test("an unavailable store retains the choice without claiming it was saved", () => {
    const storage = globalThis.localStorage;
    Reflect.deleteProperty(globalThis, "localStorage");
    try {
      const choice = {
        inputDeviceId: "built-in",
        outputDeviceId: "headphones",
        ducking: true,
      };
      expect(settings.writeVoiceAudioSettings(choice)).toBe(false);
      expect(settings.readVoiceAudioSettings()).toEqual(choice);
    } finally {
      Object.assign(globalThis, { localStorage: storage });
    }
  });

  test("a later successful write replaces the unsaved choice", () => {
    setItemFailure = new Error("QuotaExceededError");
    settings.writeVoiceAudioSettings({
      inputDeviceId: "unsaved",
      outputDeviceId: "",
      ducking: true,
    });
    setItemFailure = null;
    expect(
      settings.writeVoiceAudioSettings({
        inputDeviceId: "saved",
        outputDeviceId: "",
        ducking: false,
      }),
    ).toBe(true);
    expect(settings.readVoiceAudioSettings()).toEqual({
      inputDeviceId: "saved",
      outputDeviceId: "",
      ducking: false,
    });
    expect(JSON.parse(store.get(KEY)!).inputDeviceId).toBe("saved");
  });

  test("every read returns a fresh object, so callers cannot alias defaults", () => {
    const a = settings.readVoiceAudioSettings();
    a.ducking = false;
    expect(settings.readVoiceAudioSettings().ducking).toBe(true);
    expect(settings.DEFAULT_VOICE_AUDIO_SETTINGS.ducking).toBe(true);
  });
});

describe("resolveVoiceAudioDevice", () => {
  const devices = [
    { id: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone" },
    { id: "usb-1", label: "Blue Yeti" },
  ];

  test("an empty id is the system default and always counts as connected", () => {
    expect(settings.resolveVoiceAudioDevice("", null, "microphone")).toEqual({
      id: "",
      label: "System default",
      connected: true,
    });
  });

  test("a listed id takes the device's label", () => {
    expect(
      settings.resolveVoiceAudioDevice("usb-1", devices, "microphone"),
    ).toEqual({ id: "usb-1", label: "Blue Yeti", connected: true });
  });

  test("a saved id that is not in the list stays selected and reads as disconnected", () => {
    expect(
      settings.resolveVoiceAudioDevice("gone", devices, "microphone"),
    ).toEqual({ id: "gone", label: "Saved microphone", connected: false });
    expect(settings.resolveVoiceAudioDevice("gone", devices, "output")).toEqual(
      { id: "gone", label: "Saved output", connected: false },
    );
  });

  test("with no device list the saved id is kept without a verdict", () => {
    expect(settings.resolveVoiceAudioDevice("gone", null, "output")).toEqual({
      id: "gone",
      label: "Saved output",
      connected: null,
    });
  });
});

describe("voiceAudioBridge", () => {
  test("is absent outside a shell that exposes the native audio API", () => {
    expect(settings.voiceAudioBridge()).toBeUndefined();
  });
});
