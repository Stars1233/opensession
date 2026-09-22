import { useEffect, useState } from "react";
import type { VoiceAudioDevice } from "../lib/os1-shell";
import { voiceAudioBridge } from "../lib/voice-audio-settings";

export interface VoiceAudioDeviceList {
  inputs: VoiceAudioDevice[];
  outputs: VoiceAudioDevice[];
  /** The shell can lower other apps' audio during speech (macOS 14+). */
  advancedDucking: boolean;
}

export type VoiceAudioDevicesState =
  | { status: "loading"; devices: VoiceAudioDeviceList | null }
  | { status: "ready"; devices: VoiceAudioDeviceList }
  | { status: "error"; devices: VoiceAudioDeviceList | null; error: string };

export interface VoiceAudioDevices {
  state: VoiceAudioDevicesState;
  /** Ask the shell again, for a device plugged in since the last answer. */
  refresh: () => void;
}

type Outcome =
  | { generation: number; kind: "ready"; devices: VoiceAudioDeviceList }
  | { generation: number; kind: "error"; error: string };

function errorMessage(error: Error | string | null | undefined): string {
  const text = error instanceof Error ? error.message : (error ?? "");
  return text.trim() || "Couldn't list audio devices.";
}

/**
 * The shell's device lists, asked for through the native bridge so nothing
 * opens the microphone just to read names. Ask again with `refresh`, for a
 * headset plugged in while the dialog is open. The last list that arrived
 * stays on screen while a refresh is in flight and after one fails, so a
 * choice made against it is never pulled out from under the person.
 */
export function useVoiceAudioDevices(): VoiceAudioDevices {
  const [generation, setGeneration] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [lastDevices, setLastDevices] = useState<VoiceAudioDeviceList | null>(
    null,
  );

  useEffect(() => {
    const bridge = voiceAudioBridge();
    let cancelled = false;
    if (!bridge) {
      setOutcome({
        generation,
        kind: "error",
        error: "Audio device selection is not available in this app.",
      });
      return;
    }
    bridge.devices().then(
      (list) => {
        if (cancelled) return;
        const devices: VoiceAudioDeviceList = {
          inputs: list.inputs,
          outputs: list.outputs,
          advancedDucking: list.advancedDucking,
        };
        setOutcome({ generation, kind: "ready", devices });
        setLastDevices(devices);
      },
      (error: Error | string | null | undefined) => {
        if (cancelled) return;
        setOutcome({ generation, kind: "error", error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generation]);

  let state: VoiceAudioDevicesState;
  if (!outcome || outcome.generation !== generation) {
    state = { status: "loading", devices: lastDevices };
  } else if (outcome.kind === "ready") {
    state = { status: "ready", devices: outcome.devices };
  } else {
    state = { status: "error", devices: lastDevices, error: outcome.error };
  }
  return { state, refresh: () => setGeneration((n) => n + 1) };
}
