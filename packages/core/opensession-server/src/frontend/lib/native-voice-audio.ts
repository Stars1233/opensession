import type { NativeVoiceAudioBridge } from "./os1-shell";
import { NATIVE_VOICE_WORKLET } from "./native-voice-worklet";
import { randomUUID } from "./random-uuid";
import { readVoiceAudioSettings } from "./voice-audio-settings";

/** Keep WebRTC for transport but give native voice processing both ends of
 * the conversation. No browser microphone or audible browser destination is
 * opened, avoiding duplicate capture, playback, and echo cancellation. */
export class NativeVoiceAudio {
  private readonly id = randomUUID();
  private context: AudioContext | null = null;
  private processor: AudioWorkletNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private remote: MediaStreamAudioSourceNode | null = null;
  private unsubscribers: Array<() => void> = [];
  private closed = false;
  private paused = false;
  private epoch = 0;
  private micPending = 0;

  constructor(
    private api: NativeVoiceAudioBridge,
    private onError: (message: string) => void,
  ) {}

  async start(): Promise<MediaStream> {
    try {
      this.assertOpen();
      // A silent sink keeps Web Audio's clock running without opening the
      // system output. Only the native engine should own the audio devices.
      // Electron supports silent sinks; our DOM typings predate the option.
      const options: AudioContextOptions & { sinkId: { type: "none" } } = {
        sampleRate: 48_000,
        sinkId: { type: "none" },
      };
      const context = new AudioContext(options);
      this.context = context;
      await context.resume();
      this.assertOpen();
      const url = URL.createObjectURL(
        new Blob([NATIVE_VOICE_WORKLET], { type: "text/javascript" }),
      );
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.assertOpen();
      const processor = new AudioWorkletNode(context, "os-native-voice", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      this.processor = processor;
      processor.onprocessorerror = () =>
        this.fail("Voice audio stopped. Start the call again.");
      const destination = context.createMediaStreamDestination();
      this.destination = destination;
      processor.connect(destination);
      processor.connect(context.destination);
      processor.port.onmessage = ({ data }) => {
        if (this.closed) return;
        if (data.type === "mic-ack") {
          this.micPending = Math.max(0, this.micPending - 1);
        } else if (data.type === "playback") {
          try {
            if (!this.paused && data.epoch === this.epoch)
              this.api.push(this.id, data.samples);
            processor.port.postMessage({ type: "playback-ack" });
          } catch {
            this.fail("Voice playback failed. Start the call again.");
          }
        }
      };
      this.unsubscribers.push(
        this.api.onAudio(({ id, samples }) => {
          if (
            id !== this.id ||
            this.closed ||
            this.paused ||
            this.micPending >= 8
          )
            return;
          this.micPending++;
          processor.port.postMessage({
            type: "mic",
            samples,
            epoch: this.epoch,
          });
        }),
        this.api.onError(({ id, error }) => {
          if (id === this.id) this.fail(error);
        }),
      );
      await this.api.start(this.id, readVoiceAudioSettings());
      if (this.closed) this.api.stop(this.id);
      this.assertOpen();
      return destination.stream;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  attachOutput(stream: MediaStream) {
    if (this.closed || !this.context || !this.processor) return;
    try {
      this.remote?.disconnect();
      this.remote = this.context.createMediaStreamSource(stream);
      this.remote.connect(this.processor);
    } catch {
      this.fail("Voice playback failed. Start the call again.");
    }
  }

  setPaused(paused: boolean) {
    if (this.closed || this.paused === paused) return;
    this.paused = paused;
    this.resetBuffers();
    this.api.setPaused(this.id, paused);
  }

  clearPlayback() {
    if (this.closed) return;
    this.resetBuffers();
    this.api.clearPlayback(this.id);
  }

  private resetBuffers() {
    this.epoch++;
    this.processor?.port.postMessage({
      type: "state",
      paused: this.paused,
      epoch: this.epoch,
    });
  }

  private assertOpen() {
    if (this.closed) throw new DOMException("Call cancelled", "AbortError");
  }

  private fail(message: string) {
    if (this.closed) return;
    this.stop();
    this.onError(message);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.api.stop(this.id);
    if (this.processor) {
      this.processor.onprocessorerror = null;
      this.processor.port.onmessage = null;
      this.processor.port.close();
      this.processor.disconnect();
    }
    this.remote?.disconnect();
    for (const track of this.destination?.stream.getTracks() ?? [])
      track.stop();
    void this.context?.close().catch(() => {});
    this.processor = null;
    this.destination = null;
    this.remote = null;
    this.context = null;
  }
}
