import { agentIdentity } from "../lib/agent-identity";
import { BASE_PATH } from "../lib/base";
import { AgentAvatar } from "../ui/agent-avatar";
import { cn } from "../ui/cn";

/** Human ownership stays separate from this session's generated agent persona. */
export function AgentIdentity({
  sessionId,
  linked = false,
  className,
}: {
  sessionId?: string;
  linked?: boolean;
  className?: string;
}) {
  const name = sessionId ? agentIdentity(sessionId).name : "Unknown agent";
  const content = (
    <>
      {sessionId && <AgentAvatar sessionId={sessionId} />}
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  const classes = cn(
    "inline-flex min-w-0 items-center gap-2 text-label font-medium text-dim",
    className,
  );
  return linked && sessionId ? (
    <a
      href={`${BASE_PATH}/session/${encodeURIComponent(sessionId)}`}
      data-session-id={sessionId}
      aria-label={`Open ${name}'s session`}
      className={cn(
        classes,
        "rounded-control hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring phone:min-h-11",
      )}
    >
      {content}
    </a>
  ) : (
    <span className={classes}>{content}</span>
  );
}
