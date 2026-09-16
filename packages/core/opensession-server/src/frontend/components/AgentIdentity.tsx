import { useAgentName, useAgentSessionTitle } from "../hooks/useAgentName";
import { Tooltip } from "../ui/tooltip";
import { IconHome } from "./icons";
import { BASE_PATH } from "../lib/base";
import { AgentAvatar } from "../ui/agent-avatar";
import { cn } from "../ui/cn";

/** Human ownership stays separate from this session's generated agent persona. */
export function AgentIdentity({
  sessionId,
  linked = false,
  current = false,
  className,
}: {
  sessionId?: string;
  linked?: boolean;
  current?: boolean;
  className?: string;
}) {
  const name = useAgentName(sessionId);
  const title = useAgentSessionTitle(sessionId);
  const tooltip = (
    <AgentTooltipLabel
      name={current ? "Current agent" : name}
      sessionTitle={title}
    />
  );
  const content = (
    <>
      {sessionId && (
        <span className="relative inline-flex shrink-0">
          <AgentAvatar sessionId={sessionId} />
          {current && (
            <IconHome
              size={14}
              className="absolute -bottom-1 -right-1 rounded-full bg-surface text-dim"
            />
          )}
        </span>
      )}
      <span className="truncate">{name}</span>
    </>
  );
  const classes = cn(
    "inline-flex min-w-0 items-center gap-2 text-label font-medium text-dim",
    className,
  );
  if (current)
    return (
      <Tooltip label={tooltip} multiline>
        <span
          role="img"
          tabIndex={0}
          aria-label={`Current agent: ${name}`}
          className={cn(
            classes,
            "rounded-control focus-visible:outline-2 focus-visible:outline-focus-ring phone:min-h-11",
          )}
        >
          {content}
        </span>
      </Tooltip>
    );
  return (
    <Tooltip label={tooltip} multiline>
      {linked && sessionId ? (
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
      )}
    </Tooltip>
  );
}

/** Plain text for compact session references, using the same reactive identity. */
export function AgentName({ sessionId }: { sessionId: string }) {
  return useAgentName(sessionId);
}

/** Shared hover hierarchy for message identities and the avatar-only top bar. */
export function AgentTooltipLabel({
  name,
  sessionTitle,
}: {
  name: string;
  sessionTitle?: string;
}) {
  return (
    <>
      <span className="block">{name}</span>
      {sessionTitle && (
        <span className="mt-0.5 block text-meta font-normal text-tooltip-fg/70">
          {sessionTitle}
        </span>
      )}
    </>
  );
}
