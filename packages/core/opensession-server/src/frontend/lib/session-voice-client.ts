import { z } from "zod";
import { BASE_PATH } from "./base";

export type SessionVoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "error";
export const SESSION_VOICE_STATUS: Record<SessionVoiceState, string> = {
  idle: "Voice call",
  connecting: "Connecting…",
  listening: "Listening",
  working: "Agent working",
  speaking: "Speaking",
  error: "Voice call failed",
};
type VoiceCommand =
  | { type: "response.cancel" | "output_audio_buffer.clear" }
  | { type: "conversation.item.delete"; item_id: string }
  | {
      type: "response.create";
      response: {
        conversation: "none";
        output_modalities: ["audio"];
        max_output_tokens: number;
        input: Array<{
          type: "message";
          role: "user";
          content: Array<{ type: "input_text"; text: string }>;
        }>;
      };
    };
const START_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 3 * 60_000;
const MAX_CALL_MS = 30 * 60_000;
const answerSchema = z.object({ sdp: z.string().min(1) });
const eventSchema = z.object({
  type: z.string(),
  item_id: z.string().optional(),
  transcript: z.string().optional(),
  error: z
    .object({ message: z.string().optional(), code: z.string().optional() })
    .optional(),
  response: z.object({ status: z.string().optional() }).optional(),
});

/** WebRTC only. The agent remains behind the normal session outbox and keeps
 * all its context and permission gates. Never executes Realtime tool calls. */
export class SessionVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private abort = new AbortController();
  private state: SessionVoiceState = "idle";
  private closed = false;
  private busy = false;
  private responding = false;
  private speaking = false;
  private playing = false;
  private inputActive = false;
  private speechInProgress = false;
  private pendingReply: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private inputOrder: string[] = [];
  private inputs = new Map<string, string>();
  private delivered = new Set<string>();
  private delivering = false;

  constructor(
    private options: {
      sessionId: string;
      onState: (state: SessionVoiceState, detail?: string) => void;
      onText: (text: string) => boolean | Promise<boolean>;
    },
  ) {}

  private change(state: SessionVoiceState, detail?: string) {
    this.state = state;
    this.options.onState(state, detail);
  }

  private resting() {
    if (!this.closed && this.state !== "connecting" && !this.speaking)
      this.change(this.busy ? "working" : "listening");
  }

  setAgentBusy(busy: boolean) {
    this.busy = busy;
    this.resting();
  }

  private onPageHide = () => this.stop();
  private onVisibility = () => {
    if (document.hidden) this.stop();
  };
  private onOtherCall = () => this.stop();

  async start(): Promise<void> {
    if (this.closed || this.state !== "idle") return;
    window.dispatchEvent(new Event("opensession-voice-call-start"));
    window.addEventListener("opensession-voice-call-start", this.onOtherCall);
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.change("connecting");
    this.startTimer = setTimeout(
      () => this.fail("Voice connection timed out. Try again."),
      START_TIMEOUT_MS,
    );
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Voice calls need a secure browser with microphone access.",
        );
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.closed) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      this.mic = mic;
      for (const track of mic.getTracks())
        track.onended = () => this.fail("The microphone disconnected.");
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      pc.ontrack = (event) => {
        if (!this.audio || this.closed) return;
        this.audio.srcObject =
          event.streams[0] ?? new MediaStream([event.track]);
        void this.audio
          .play()
          .catch(() =>
            this.fail("Audio playback was blocked. Start the call again."),
          );
      };
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        )
          this.fail("Voice connection lost. Start the call again.");
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);
      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (event) => this.handleEvent(event.data);
      channel.onclose = () => this.fail("Voice connection closed.");
      channel.onopen = () => {
        if (this.closed) return;
        clearTimeout(this.startTimer);
        this.change(this.busy ? "working" : "listening");
        this.touch();
        this.maxTimer = setTimeout(() => this.stop(), MAX_CALL_MS);
        this.flushReply();
      };
      await pc.setLocalDescription(await pc.createOffer());
      if (this.closed) return;
      const response = await fetch(
        `${BASE_PATH}/api/sessions/${encodeURIComponent(this.options.sessionId)}/voice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
          signal: this.abort.signal,
        },
      );
      const data = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(data);
        throw new Error(
          error.success ? error.data.error : "Could not start the voice call.",
        );
      }
      if (this.closed) return;
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSchema.parse(data).sdp,
      });
    } catch (error) {
      if (this.closed) return;
      this.fail(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission denied. Allow access and try again."
          : error instanceof Error && error.name === "NotFoundError"
            ? "No microphone found. Connect one and try again."
            : error instanceof Error
              ? error.message
              : "Could not start the voice call.",
      );
    }
  }

  /** Each completed agent turn is summarized out of conversation. Keeping the
   * reply out of Realtime history avoids growing a second agent context. */
  speak(reply: string) {
    if (this.closed) return;
    this.pendingReply = reply;
    this.flushReply();
  }

  private flushReply() {
    if (
      !this.pendingReply ||
      this.channel?.readyState !== "open" ||
      this.inputActive ||
      this.responding ||
      this.speaking ||
      this.closed
    )
      return;
    const text = this.pendingReply;
    this.pendingReply = null;
    this.responding = true;
    this.speaking = true;
    this.change("speaking");
    this.touch();
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        max_output_tokens: 700,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Completed agent reply (summarize for speech only):\n${text.slice(0, 24_000)}`,
              },
            ],
          },
        ],
      },
    });
  }

  private send(event: VoiceCommand) {
    if (this.channel?.readyState === "open" && !this.closed)
      this.channel.send(JSON.stringify(event));
  }

  private handleEvent(raw: string) {
    if (this.closed) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.inputActive = true;
        this.speechInProgress = true;
        this.pendingReply = null;
        this.touch();
        // Barge-in stops speech, never the coding agent's work.
        if (this.responding) this.send({ type: "response.cancel" });
        if (this.playing) this.send({ type: "output_audio_buffer.clear" });
        this.speaking = false;
        this.resting();
        break;
      case "input_audio_buffer.speech_stopped":
        this.speechInProgress = false;
        break;
      case "input_audio_buffer.committed":
        if (
          event.item_id &&
          !this.delivered.has(event.item_id) &&
          !this.inputOrder.includes(event.item_id)
        )
          this.inputOrder.push(event.item_id);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (!event.item_id || this.delivered.has(event.item_id)) break;
        if (!this.inputOrder.includes(event.item_id))
          this.inputOrder.push(event.item_id);
        this.inputs.set(event.item_id, event.transcript?.trim() ?? "");
        void this.deliverInputs();
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.fail(
          "Could not transcribe your speech. Please send it in the chat.",
        );
        break;
      case "response.done":
        this.responding = false;
        if (event.response?.status === "failed") {
          this.fail(
            "Could not speak the agent's reply. The full reply is in the chat.",
          );
          break;
        }
        this.flushReply();
        break;
      case "output_audio_buffer.started":
        this.playing = true;
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.playing = false;
        this.speaking = false;
        this.resting();
        this.flushReply();
        break;
      case "error":
        // A VAD interruption and our explicit cancel can race safely.
        if (event.error?.code === "response_cancel_not_active") break;
        this.fail(event.error?.message || "Voice call failed.");
        break;
    }
  }

  private async deliverInputs() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (!this.closed && this.inputOrder.length) {
        const id = this.inputOrder[0]!;
        const text = this.inputs.get(id);
        if (text === undefined) break;
        this.inputOrder.shift();
        this.inputs.delete(id);
        this.delivered.add(id);
        if (text) {
          this.pendingReply = null;
          if (!(await this.options.onText(text))) {
            this.fail(
              "Could not send your speech. Please send it in the chat.",
            );
            break;
          }
          this.setAgentBusy(true);
        }
        // Audio input is not needed in Realtime's context after transcription.
        this.send({ type: "conversation.item.delete", item_id: id });
      }
      this.inputActive = this.speechInProgress || this.inputOrder.length > 0;
      this.resting();
      this.flushReply();
    } catch {
      this.fail("Could not send your speech. Please send it in the chat.");
    } finally {
      this.delivering = false;
    }
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy) this.touch();
      else this.stop();
    }, IDLE_TIMEOUT_MS);
  }

  private fail(message: string) {
    if (this.closed) return;
    this.teardown();
    this.change("error", message);
  }

  stop() {
    if (this.closed) return;
    this.teardown();
    this.change("idle");
  }

  private teardown() {
    this.closed = true;
    this.abort.abort();
    clearTimeout(this.startTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    window.removeEventListener(
      "opensession-voice-call-start",
      this.onOtherCall,
    );
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.channel) {
      this.channel.onmessage =
        this.channel.onclose =
        this.channel.onopen =
          null;
      this.channel.close();
    }
    if (this.pc) {
      this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    for (const track of this.mic?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.channel = null;
    this.pc = null;
    this.mic = null;
    this.audio = null;
    this.pendingReply = null;
    this.inputs.clear();
    this.inputOrder = [];
  }
}
