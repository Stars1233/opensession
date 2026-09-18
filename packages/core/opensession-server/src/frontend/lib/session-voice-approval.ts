import type { SessionVoiceRequest } from "../../shared/session-voice";

export type VoiceApprovalDecision = "approved" | "declined" | "unclear";

/** Deliberately narrow: a qualified yes ("yes, but don't send it") must never
 * authorize a different action. The next utterance consumes the proposal. */
export function voiceApprovalDecision(text: string): VoiceApprovalDecision {
  const normalized = text
    .toLowerCase()
    .replace(/[.,!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(yes|yeah|yep|sure|okay|ok|go ahead|do it|yes please|yes go ahead|yeah go ahead|sure go ahead|yes do it|yes send it|yes ask the agent|yes that's fine|yes that sounds good|please do|ja|ja graag|ja doe maar|doe maar)$/.test(
      normalized,
    )
  )
    return "approved";
  if (
    /^(no|nope|no thanks|no thank you|not now|cancel|cancel that|don't|do not|nee|nee bedankt)$/.test(
      normalized,
    )
  )
    return "declined";
  return "unclear";
}

/** Approval must be fresh microphone input after our confirmation has begun
 * playing. Neither model-authored tool arguments nor replayed ASR can approve. */
export class SessionVoiceApproval {
  private request: SessionVoiceRequest | null = null;
  private questionResponse: string | null = null;
  private audible = false;
  private inputId: string | null = null;

  get pending(): boolean {
    return this.request !== null;
  }

  propose(request: SessionVoiceRequest) {
    this.clear();
    this.request = request;
  }

  questionCreated(responseId: string, requestId: string) {
    if (requestId === this.request?.callId) this.questionResponse = responseId;
  }

  playbackStarted(responseId: string) {
    if (this.request && responseId === this.questionResponse)
      this.audible = true;
  }

  speechStarted(itemId: string) {
    if (!this.request || !this.audible || this.inputId) return;
    this.inputId = itemId;
    this.audible = false;
  }

  transcript(
    itemId: string,
    text: string,
  ): { request: SessionVoiceRequest; decision: VoiceApprovalDecision } | null {
    if (!this.request || itemId !== this.inputId) return null;
    const request = this.request;
    this.clear();
    return { request, decision: voiceApprovalDecision(text) };
  }

  clear() {
    this.request = null;
    this.questionResponse = null;
    this.audible = false;
    this.inputId = null;
  }
}
