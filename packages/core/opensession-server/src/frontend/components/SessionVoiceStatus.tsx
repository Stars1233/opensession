import { Button } from "../ui/button";
import {
  SESSION_VOICE_STATUS,
  type SessionVoiceState,
} from "../lib/session-voice-client";
import type { SessionVoiceAgentRequest } from "../../shared/session-voice";

export function SessionVoiceStatus({
  state,
  error,
  proposal,
  onResolve,
  onDismiss,
}: {
  state: SessionVoiceState;
  error: string | null;
  proposal: SessionVoiceAgentRequest | null;
  onResolve: (approve: boolean) => Promise<void>;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-t-lg bg-panel px-4 py-3 text-meta text-dim">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1" role={error ? "alert" : "status"}>
          {error ? (
            <p>{error}</p>
          ) : (
            <>
              <p className="font-medium text-fg">
                {SESSION_VOICE_STATUS[state]}
              </p>
              <p>
                Voice stays out of the thread. Agent requests need approval.
              </p>
            </>
          )}
        </div>
        {error && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 phone:min-h-11"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      {proposal && (
        <div
          className="mt-3 space-y-2"
          role="group"
          aria-label="Approve agent request"
        >
          <p className="font-medium text-fg">Ask the session agent?</p>
          <p>{proposal.reason} This may take a few minutes.</p>
          <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-3 text-fg">
            {proposal.prompt}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              className="phone:min-h-11"
              onClick={() => void onResolve(true)}
            >
              Ask agent
            </Button>
            <Button
              size="sm"
              variant="soft"
              className="phone:min-h-11"
              onClick={() => void onResolve(false)}
            >
              Not now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
