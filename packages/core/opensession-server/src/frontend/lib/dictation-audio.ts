import { NativeVoiceAudio } from "./native-voice-audio";
import { os1Shell } from "./os1-shell";

/** Own capture independently of the recorder and recognizer. The Mac path
 * shares device/ducking preferences with calls; older shells and browsers
 * keep getUserMedia. A failed selected device never falls back to another. */
export class DictationAudio {
  private native: NativeVoiceAudio | null = null;
  private stream: MediaStream | null = null;
  private closed = false;

  constructor(private onError: (message: string) => void) {}

  async start(): Promise<MediaStream> {
    if (this.closed)
      throw new DOMException("Dictation cancelled", "AbortError");
    try {
      const bridge = os1Shell()?.voiceAudio;
      if (bridge) {
        this.native = new NativeVoiceAudio(bridge, (message) =>
          this.fail(message),
        );
      }
      const stream = this.native
        ? await this.native.start()
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop();
        throw new DOMException("Dictation cancelled", "AbortError");
      }
      this.stream = stream;
      for (const track of stream.getTracks())
        track.onended = () => this.fail("The microphone disconnected.");
      return stream;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private fail(message: string) {
    if (this.closed) return;
    this.stop();
    this.onError(message);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.native?.stop();
    this.native = null;
    this.stream = null;
  }
}
