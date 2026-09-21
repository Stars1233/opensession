import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceAudioSettingsForm } from "./VoiceAudioSettings";
import type { VoiceAudioDevicesState } from "../../hooks/useVoiceAudioDevices";

const ready: VoiceAudioDevicesState = {
  status: "ready",
  devices: {
    inputs: [
      { id: "BuiltInMicrophoneDevice", label: "MacBook Pro Microphone" },
      { id: "usb-1", label: "Blue Yeti" },
    ],
    outputs: [{ id: "bt-1", label: "AirPods Pro" }],
    advancedDucking: true,
  },
};

const defaults = { inputDeviceId: "", outputDeviceId: "", ducking: true };

function render(
  props: Partial<Parameters<typeof VoiceAudioSettingsForm>[0]> = {},
) {
  return renderToStaticMarkup(
    <VoiceAudioSettingsForm
      settings={defaults}
      devices={ready}
      onChange={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

describe("VoiceAudioSettingsForm", () => {
  test("names both device pickers and the ducking switch for assistive tech", () => {
    const html = render();
    expect(html).toContain('aria-label="Microphone"');
    expect(html).toContain('aria-label="Output"');
    expect(html).toContain("Lower other audio during speech");
    expect(html).toContain("System default");
  });

  test("tells the person the choice reaches the next call, not this one", () => {
    expect(render({ callActive: true })).toContain("apply to your next call");
    expect(render()).not.toContain("apply to your next call");
  });

  test("keeps a saved device that is not listed and says it is disconnected", () => {
    const html = render({
      settings: { ...defaults, inputDeviceId: "gone" },
    });
    expect(html).toContain("Not connected right now");
  });

  test("disables ducking with the requirement when the shell cannot do it", () => {
    const html = render({
      devices: {
        status: "ready",
        devices: { ...ready.devices, advancedDucking: false },
      },
    });
    expect(html).toContain("Requires macOS 14 or later.");
    expect(html).toMatch(/role="switch"[^>]*(data-disabled|aria-disabled)/);
  });

  test("a listing failure keeps the form and offers a retry", () => {
    const html = render({
      devices: { status: "error", devices: null, error: "helper exited" },
    });
    expect(html).toContain("helper exited");
    expect(html).toContain("Try again");
    expect(html).toContain('aria-label="Microphone"');
  });

  test("a refused save is said out loud", () => {
    // The apostrophe is entity-escaped in static markup.
    expect(render({ saveFailed: true })).toContain("save these settings");
    expect(render()).not.toContain("save these settings");
  });

  test("the ducking copy does not promise silence when off", () => {
    const html = render();
    expect(html).toContain("least macOS allows");
    expect(html).not.toMatch(/never lower|no fade|not lowered/i);
  });
});
