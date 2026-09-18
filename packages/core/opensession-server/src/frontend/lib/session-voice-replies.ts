import type { TranscriptEntry } from "./types";

function latestReply(entries: TranscriptEntry[]) {
  return entries.findLast(
    (entry) =>
      entry.type === "assistant" && !entry.isReasoning && entry.content.trim(),
  );
}

/** Never narrate old history when a call starts, a page loads, or the socket
 * replays. Wait for the existing agent to finish rather than reading partial
 * text, reasoning, or tool output. The canonical full reply stays in chat. */
export class SessionVoiceReplies {
  private last: TranscriptEntry | undefined;
  private sequence: number;
  private timestamp: number;
  private startedEmpty: boolean;
  private spokenId: string | undefined;

  constructor(entries: TranscriptEntry[], now = Date.now()) {
    const last = latestReply(entries);
    this.last = last ? { ...last } : undefined;
    this.startedEmpty = entries.length === 0;
    this.sequence = entries.reduce(
      (max, entry) => Math.max(max, entry.seq ?? 0),
      0,
    );
    this.timestamp = entries.length
      ? entries.reduce(
          (max, entry) => Math.max(max, Date.parse(entry.timestamp) || 0),
          0,
        )
      : now;
  }

  take(entries: TranscriptEntry[], busy: boolean): string | null {
    if (busy) return null;
    const reply = latestReply(entries);
    if (
      !reply ||
      reply.id === this.spokenId ||
      (reply.id === this.last?.id && reply.content === this.last.content)
    )
      return null;
    if (
      reply.id !== this.last?.id &&
      (reply.seq !== undefined
        ? reply.seq <= this.sequence
        : Date.parse(reply.timestamp) <= this.timestamp)
    )
      return null;
    if (this.startedEmpty && Date.parse(reply.timestamp) < this.timestamp)
      return null;
    this.startedEmpty = false;
    this.last = { ...reply };
    this.spokenId = reply.id;
    this.sequence = Math.max(this.sequence, reply.seq ?? 0);
    this.timestamp = Math.max(this.timestamp, Date.parse(reply.timestamp) || 0);
    return reply.content;
  }
}
