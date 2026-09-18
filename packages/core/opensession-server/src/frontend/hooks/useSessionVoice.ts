import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  SessionVoiceClient,
  type SessionVoiceState,
} from "../lib/session-voice-client";
import {
  SessionVoiceReplies,
  SessionVoiceAgentReply,
} from "../lib/session-voice-replies";
import {
  sessionVoiceContext,
  type SessionVoiceAgentRequest,
} from "../../shared/session-voice";
import type { TranscriptEntry } from "../lib/types";

/** The call discusses the thread without writing to it. Only approval of an
 * explicit proposal can invoke the existing session send path. */
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
  const [proposal, setProposal] = useState<SessionVoiceAgentRequest | null>(
    null,
  );
  const clientRef = useRef<SessionVoiceClient | null>(null);
  const updatesRef = useRef<SessionVoiceReplies | null>(null);
  const agentReplyRef = useRef<SessionVoiceAgentReply | null>(null);
  const startCall = useEffectEvent(() => {
    updatesRef.current = new SessionVoiceReplies(entries);
    agentReplyRef.current = null;
    const client = new SessionVoiceClient({
      sessionId,
      context: sessionVoiceContext(entries),
      onRequest: (request) => {
        if (clientRef.current === client) setProposal(request);
      },
      onState: (next, detail) => {
        if (clientRef.current !== client) return;
        setState(next);
        if (next === "idle" || next === "error") setRequestedSession(null);
        if (next === "error") setError(detail ?? "Voice call failed.");
      },
    });
    clientRef.current = client;
    void client.start();
    return client;
  });

  useEffect(() => {
    if (!requested || !enabled) {
      setRequestedSession(null);
      setProposal(null);
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
    if (updatesRef.current?.take(entries, busy))
      clientRef.current?.updateContext(sessionVoiceContext(entries));
    const reply = agentReplyRef.current?.take(entries, busy);
    if (reply) {
      agentReplyRef.current = null;
      clientRef.current?.agentReply(reply);
    }
  }, [requested, busy, entries]);

  async function resolveProposal(approve: boolean) {
    const client = clientRef.current;
    if (!enabled || !client || !proposal) return;
    setProposal(null);
    if (approve)
      agentReplyRef.current = new SessionVoiceAgentReply(
        proposal.prompt,
        entries,
      );
    const accepted = await client.resolveAgentRequest(
      proposal.callId,
      approve,
      onSend,
    );
    if (clientRef.current === client && !accepted) agentReplyRef.current = null;
  }

  function toggle() {
    if (!enabled && !requested) return;
    setError(null);
    setRequestedSession(requested ? null : sessionId);
  }

  return {
    state,
    active: requested,
    error,
    proposal,
    resolveProposal,
    toggle,
    dismissError: () => setError(null),
  };
}
