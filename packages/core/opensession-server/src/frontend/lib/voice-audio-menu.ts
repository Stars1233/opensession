// The rows a device picker in the voice audio menu draws, worked out away
// from the component so a test can pin them without a menu to mount.

import type { VoiceAudioDevice } from "./os1-shell";
import { resolveVoiceAudioDevice } from "./voice-audio-settings";

export interface VoiceAudioDeviceRow {
  /** Native device id; "" is the system default. */
  id: string;
  label: string;
  /** A second line under the label, for a saved device that is not here. */
  note?: string;
  /** The row cannot be picked: it is the saved device the machine does not
   *  list right now. It stays on screen and selected rather than being
   *  quietly swapped for the system default, which after pairing a headset
   *  is usually that headset's low quality microphone. */
  disabled: boolean;
}

export function voiceAudioDeviceRows(
  value: string,
  devices: VoiceAudioDevice[] | null,
  kind: "microphone" | "output",
): VoiceAudioDeviceRow[] {
  const rows: VoiceAudioDeviceRow[] = [
    { id: "", label: "System default", disabled: false },
    ...(devices ?? []).map((device) => ({
      id: device.id,
      label: device.label,
      disabled: false,
    })),
  ];
  if (value !== "" && !devices?.some((device) => device.id === value)) {
    const selection = resolveVoiceAudioDevice(value, devices, kind);
    rows.push({
      id: value,
      label: selection.label,
      note: selection.connected === false ? "Not connected" : undefined,
      disabled: selection.connected === false,
    });
  }
  return rows;
}
