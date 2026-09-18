import { Button } from "../ui/button";
import {
  SESSION_VOICE_STATUS,
  type SessionVoiceState,
} from "../lib/session-voice-client";

export function SessionVoiceStatus({
  state,
  error,
  onDismiss,
}: {
  state: SessionVoiceState;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-t-lg bg-panel px-4 py-2 text-meta text-dim"
      role={error ? "alert" : "status"}
    >
      <div className="min-w-0 flex-1">
        {error ? (
          <p>{error}</p>
        ) : (
          <>
            <p className="font-medium text-fg">{SESSION_VOICE_STATUS[state]}</p>
            <p>Speech sends automatically. Replies are summarized aloud.</p>
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
  );
}
