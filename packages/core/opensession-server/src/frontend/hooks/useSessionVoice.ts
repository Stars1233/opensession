import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  SessionVoiceClient,
  type SessionVoiceState,
} from "../lib/session-voice-client";
import { SessionVoiceReplies } from "../lib/session-voice-replies";
import type { TranscriptEntry } from "../lib/types";

/** Voice is bound to the visible session, not the reusable composer lifetime. */
export function useSessionVoice({
  sessionId,
  enabled,
  busy,
  entries,
  onSend,
}: {
  sessionId: string;
  enabled: boolean;
  busy: boolean;
  entries: TranscriptEntry[];
  onSend: (text: string) => boolean | Promise<boolean>;
}) {
  const [requestedSession, setRequestedSession] = useState<string | null>(null);
  const requested = requestedSession === sessionId;
  const [state, setState] = useState<SessionVoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<SessionVoiceClient | null>(null);
  const repliesRef = useRef<SessionVoiceReplies | null>(null);
  const sendText = useEffectEvent((text: string) => enabled && onSend(text));
  const startCall = useEffectEvent(() => {
    repliesRef.current = new SessionVoiceReplies(entries);
    const client = new SessionVoiceClient({
      sessionId,
      onText: (text) => sendText(text),
      onState: (next, detail) => {
        if (clientRef.current !== client) return;
        setState(next);
        if (next === "idle" || next === "error") setRequestedSession(null);
        if (next === "error") setError(detail ?? "Voice call failed.");
      },
    });
    clientRef.current = client;
    void client.start();
    client.setAgentBusy(busy);
    return client;
  });

  useEffect(() => {
    if (!requested || !enabled) {
      setRequestedSession(null);
      setState("idle");
      return;
    }
    const client = startCall();
    return () => {
      clientRef.current = null;
      client.stop();
    };
  }, [sessionId, enabled, requested]);

  useEffect(() => {
    if (!requested) return;
    clientRef.current?.setAgentBusy(busy);
    const reply = repliesRef.current?.take(entries, busy);
    if (reply) clientRef.current?.speak(reply);
  }, [requested, busy, entries]);

  function toggle() {
    if (!enabled && !requested) return;
    setError(null);
    setRequestedSession(requested ? null : sessionId);
  }

  return {
    state,
    active: requested,
    error,
    toggle,
    dismissError: () => setError(null),
  };
}
