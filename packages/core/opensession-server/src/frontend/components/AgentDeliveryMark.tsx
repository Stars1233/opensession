import type { TranscriptEntry } from "../lib/types";
import { agentDeliveryStatus } from "../lib/agent-message";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import {
  IconCheck,
  IconClock,
  IconQuestionCircle,
  IconWarningTriangle,
} from "./icons";

/** Delivery evidence, not read receipts: a completed send may only be queued. */
export function AgentDeliveryMark({ result }: { result?: TranscriptEntry }) {
  const status = agentDeliveryStatus(result);
  return (
    <Tooltip label={status}>
      <span
        role="img"
        aria-label={status}
        tabIndex={0}
        data-agent-delivery={status}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-control text-faint focus-visible:outline-2 focus-visible:outline-focus-ring phone:min-h-11 phone:min-w-11",
          status === "Not sent" && "text-red",
        )}
      >
        {status === "Sent" || status === "Handled" ? (
          <span className="inline-flex -space-x-2" aria-hidden="true">
            <IconCheck className="size-4" />
            {status === "Handled" && <IconCheck className="size-4" />}
          </span>
        ) : status === "Queued" ? (
          <IconClock className="size-4" />
        ) : status === "Not sent" ? (
          <IconWarningTriangle className="size-4" />
        ) : (
          <IconQuestionCircle className="size-4" />
        )}
      </span>
    </Tooltip>
  );
}
