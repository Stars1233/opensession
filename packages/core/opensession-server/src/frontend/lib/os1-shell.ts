export interface VoiceAudioDevice {
  id: string;
  label: string;
}

export interface NativeVoiceAudioBridge {
  devices(): Promise<{
    inputs: VoiceAudioDevice[];
    outputs: VoiceAudioDevice[];
    advancedDucking: boolean;
  }>;
  start(
    id: string,
    options: {
      inputDeviceId: string;
      outputDeviceId: string;
      ducking: boolean;
    },
  ): Promise<void>;
  push(id: string, samples: Float32Array): void;
  setPaused(id: string, paused: boolean): void;
  clearPlayback(id: string): void;
  stop(id: string): void;
  onAudio(
    callback: (payload: { id: string; samples: Float32Array }) => void,
  ): () => void;
  onError(
    callback: (payload: { id: string; error: string }) => void,
  ): () => void;
}

export interface OS1ShellBridge {
  desktop?: boolean;
  materialBackdrop?: boolean;
  focusWindow?: () => void;
  organizations?: unknown;
  updates?: unknown;
  voiceAudio?: NativeVoiceAudioBridge;
  dictation?: {
    start(
      id: string,
      sampleRate: number,
      language: string,
    ): Promise<{ ok?: boolean }>;
    push(id: string, samples: Float32Array): void;
    finish(id: string): Promise<{ text?: string }>;
    cancel(id: string): void;
    onText(
      callback: (payload: { id?: string; text?: string }) => void,
    ): () => void;
  };
}

declare global {
  interface Window {
    os1?: OS1ShellBridge;
  }
}

export function os1Shell(): OS1ShellBridge | undefined {
  return globalThis.window?.os1;
}
