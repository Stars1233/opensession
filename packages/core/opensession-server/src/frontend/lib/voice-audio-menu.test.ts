import { describe, expect, test } from "bun:test";
import { voiceAudioDeviceRows } from "./voice-audio-menu";

const inputs = [
  { id: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone" },
  { id: "usb-1", label: "Blue Yeti" },
];

describe("voiceAudioDeviceRows", () => {
  test("leads with the system default, then the machine's devices", () => {
    expect(voiceAudioDeviceRows("", inputs, "microphone")).toEqual([
      { id: "", label: "System default", disabled: false },
      {
        id: "BuiltInMicrophoneDevice",
        label: "MacBook Pro Microphone",
        disabled: false,
      },
      { id: "usb-1", label: "Blue Yeti", disabled: false },
    ]);
  });

  test("keeps a saved device that is not listed, visible and disabled", () => {
    const rows = voiceAudioDeviceRows("gone", inputs, "microphone");
    expect(rows.at(-1)).toEqual({
      id: "gone",
      label: "Saved microphone",
      note: "Not connected",
      disabled: true,
    });
    // It is still the selected value: nothing resets it to the default.
    expect(rows.filter((row) => row.id === "gone")).toHaveLength(1);
  });

  test("does not call a saved device disconnected before the list arrives", () => {
    const rows = voiceAudioDeviceRows("usb-1", null, "output");
    expect(rows).toEqual([
      { id: "", label: "System default", disabled: false },
      { id: "usb-1", label: "Saved output", note: undefined, disabled: false },
    ]);
  });

  test("a saved device that is listed appears once", () => {
    const rows = voiceAudioDeviceRows("usb-1", inputs, "microphone");
    expect(rows.filter((row) => row.id === "usb-1")).toHaveLength(1);
    expect(rows.some((row) => row.disabled)).toBe(false);
  });
});
