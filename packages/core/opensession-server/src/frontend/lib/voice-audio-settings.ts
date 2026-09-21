// Voice call audio routing on the Mac desktop shell: which microphone and
// output a realtime call uses, and whether other apps' audio is lowered
// while someone speaks.
//
// The choice is about the machine in front of the person (which headset is
// plugged into THIS Mac), so it lives in localStorage per origin and never
// rides the server's ui-prefs. The native transport reads it when a call
// starts; nothing re-routes a call already in progress.

import { z } from "zod";
import {
  os1Shell,
  type NativeVoiceAudioBridge,
  type VoiceAudioDevice,
} from "./os1-shell";

export const VOICE_AUDIO_SETTINGS_KEY = "opensession:voice-audio:v1";

export interface VoiceAudioSettings {
  /** Native device id of the microphone; "" follows the system default. */
  inputDeviceId: string;
  /** Native device id of the output; "" follows the system default. */
  outputDeviceId: string;
  /** Lower other apps' audio while speech is happening. */
  ducking: boolean;
}

export const DEFAULT_VOICE_AUDIO_SETTINGS: VoiceAudioSettings = {
  inputDeviceId: "",
  outputDeviceId: "",
  ducking: true,
};

// Each field falls back on its own, so one corrupt field does not cost the
// person the rest of their choices.
const storedSchema = z.object({
  inputDeviceId: z.string().catch(DEFAULT_VOICE_AUDIO_SETTINGS.inputDeviceId),
  outputDeviceId: z.string().catch(DEFAULT_VOICE_AUDIO_SETTINGS.outputDeviceId),
  ducking: z.boolean().catch(DEFAULT_VOICE_AUDIO_SETTINGS.ducking),
});

/** Coerces anything found in storage to a complete, well-typed settings
 *  object. Missing or malformed fields take their defaults. */
export function parseVoiceAudioSettings(
  raw: string | null,
): VoiceAudioSettings {
  if (!raw) return { ...DEFAULT_VOICE_AUDIO_SETTINGS };
  try {
    const result = storedSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : { ...DEFAULT_VOICE_AUDIO_SETTINGS };
  } catch {
    return { ...DEFAULT_VOICE_AUDIO_SETTINGS };
  }
}

// A choice storage refused (quota, a private-mode store). The native
// transport reads through `readVoiceAudioSettings` when a call starts, so the
// choice has to survive here for the call to honour it: falling back to the
// stored (or default) value would quietly hand a paired headset's low quality
// microphone to the next call after the person had just picked the built-in
// one. Cleared by the next write storage accepts, which is then the truth.
let unsaved: VoiceAudioSettings | null = null;

export function readVoiceAudioSettings(): VoiceAudioSettings {
  if (unsaved) return { ...unsaved };
  try {
    return parseVoiceAudioSettings(
      globalThis.localStorage?.getItem(VOICE_AUDIO_SETTINGS_KEY) ?? null,
    );
  } catch {
    return { ...DEFAULT_VOICE_AUDIO_SETTINGS };
  }
}

/** Remembers the choice for this page and stores it for the next one.
 *  Returns whether storage accepted it; `false` means the choice applies to
 *  calls in this window only, which the dialog says out loud. */
export function writeVoiceAudioSettings(value: VoiceAudioSettings): boolean {
  const next: VoiceAudioSettings = {
    inputDeviceId: value.inputDeviceId,
    outputDeviceId: value.outputDeviceId,
    ducking: value.ducking,
  };
  try {
    globalThis.localStorage.setItem(
      VOICE_AUDIO_SETTINGS_KEY,
      JSON.stringify(next),
    );
    unsaved = null;
    return true;
  } catch {
    unsaved = next;
    return false;
  }
}

/** The native audio bridge, present only in a Mac shell that ships it. Other
 *  clients and older shells get `undefined`, and every voice audio surface
 *  stays hidden there. */
export function voiceAudioBridge(): NativeVoiceAudioBridge | undefined {
  return os1Shell()?.voiceAudio;
}

export interface VoiceAudioSelection {
  id: string;
  label: string;
  /** Whether the saved device appears in the current device list. `null`
   *  while the list is unknown (still loading, or listing failed). */
  connected: boolean | null;
}

/** What to show for a saved device id against the devices the machine has
 *  right now. A saved device that has gone missing stays selected and says
 *  so, rather than being quietly swapped for whatever the system default
 *  is, which after pairing a headset is usually its low quality microphone. */
export function resolveVoiceAudioDevice(
  id: string,
  devices: VoiceAudioDevice[] | null,
  kind: "microphone" | "output",
): VoiceAudioSelection {
  if (id === "") return { id, label: "System default", connected: true };
  const match = devices?.find((device) => device.id === id);
  if (match) return { id, label: match.label, connected: true };
  return {
    id,
    label: `Saved ${kind}`,
    connected: devices ? false : null,
  };
}
