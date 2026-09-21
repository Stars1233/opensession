/** Loaded only by the native Mac transport. The worklet is a PCM bridge, not
 * an echo canceller: AVAudioEngine owns voice processing and physical I/O.
 * Both message directions have bounded outstanding packets; stalled renderer
 * frames drop audio rather than accumulate seconds of delayed conversation. */
export const NATIVE_VOICE_WORKLET = `
class NativeVoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mic = new Float32Array(12000);
    this.read = 0;
    this.length = 0;
    this.packet = new Float32Array(960);
    this.used = 0;
    this.outstanding = 0;
    this.paused = false;
    this.epoch = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'mic') {
        if (!this.paused && data.epoch === this.epoch) {
          const samples = data.samples;
          for (let i = 0; i < samples.length; i++) {
            if (this.length === this.mic.length) {
              this.read = (this.read + 1) % this.mic.length;
              this.length--;
            }
            this.mic[(this.read + this.length) % this.mic.length] = samples[i];
            this.length++;
          }
        }
        this.port.postMessage({ type: 'mic-ack' });
      } else if (data.type === 'playback-ack') {
        this.outstanding = Math.max(0, this.outstanding - 1);
      } else if (data.type === 'state') {
        // Barge-in clears playback without losing the user's first syllable.
        if (this.paused !== data.paused) this.read = this.length = 0;
        this.paused = data.paused;
        this.epoch = data.epoch;
        this.used = 0;
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0][0];
    const input = inputs[0]?.[0];
    for (let i = 0; i < output.length; i++) {
      output[i] = 0;
      if (this.paused) continue;
      if (this.length) {
        output[i] = this.mic[this.read];
        this.read = (this.read + 1) % this.mic.length;
        this.length--;
      }
      this.packet[this.used++] = input?.[i] ?? 0;
      if (this.used === this.packet.length) {
        if (this.outstanding < 4) {
          this.port.postMessage({ type: 'playback', samples: this.packet, epoch: this.epoch }, [this.packet.buffer]);
          this.outstanding++;
          this.packet = new Float32Array(960);
        }
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('os-native-voice', NativeVoiceProcessor);
`;
