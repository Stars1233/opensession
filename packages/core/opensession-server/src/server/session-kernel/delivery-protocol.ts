import type {
  DeliverySlot,
  DurableDeliveryState,
  DurableSteerTarget,
} from "./store";
import type { DurableRunTarget } from "./turn-protocol";

export function deliveryInterruptForAnchor(
  state: DurableDeliveryState,
  anchorId: string,
): DurableDeliveryState["interrupt"] {
  const dispatchInterrupt = (
    state.dispatch as
      | { interrupt?: DurableDeliveryState["interrupt"] }
      | undefined
  )?.interrupt;
  const interrupt = state.interrupt || dispatchInterrupt;
  return interrupt?.anchorId === anchorId ? interrupt : undefined;
}

export function targetForDeliveryInterrupt(
  interrupt: DurableDeliveryState["interrupt"],
  anchorId: string,
): DurableRunTarget | undefined {
  return interrupt?.anchorId === anchorId && interrupt.dispatchId
    ? { runId: interrupt.dispatchId, generation: interrupt.runGeneration }
    : undefined;
}

export type SubmitPromptCommandPlan =
  | { status: "execute" }
  | { status: "in_progress" }
  | { status: "completed"; result: unknown; duplicate: true };

type DeliveryItem = {
  id?: string;
  promptEntryId?: string;
} & Record<string, unknown>;

export type DeliveryActorRequest =
  | { op: "snapshot"; sessionId: string }
  | {
      op: "request_submit_command";
      sessionId: string;
      requestId: string;
      identity: unknown;
    }
  | {
      op: "complete_submit_command";
      sessionId: string;
      requestId: string;
      result: unknown;
    }
  | {
      op: "fail_submit_command";
      sessionId: string;
      requestId: string;
      error: string;
    }
  | { op: "entries"; slot: DeliverySlot }
  | { op: "set"; sessionId: string; slot: DeliverySlot; value: unknown }
  | { op: "enqueue"; sessionId: string; item: unknown; front?: boolean }
  | {
      op: "promote_queued";
      sessionId: string;
      itemId: string;
      promptEntryId: string;
      item?: unknown;
    }
  | { op: "delete"; sessionId: string; slot: DeliverySlot }
  | { op: "clear_slot"; slot: DeliverySlot }
  | {
      op: "prepare_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
      item?: unknown;
    }
  | {
      op: "accept_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
    }
  | {
      op: "reject_steer";
      sessionId: string;
      itemId: string;
      target: DurableSteerTarget;
    }
  | { op: "settle_pending_steers" }
  | { op: "requeue_steers"; sessionId: string; items: unknown[] }
  | {
      op: "prepare_interrupt";
      sessionId: string;
      interruptId: string;
      anchorId: string;
      dispatchId: string;
      soloId?: string;
    }
  | {
      op: "begin_interrupt_effect";
      sessionId: string;
      interruptId: string;
      runGeneration: number;
    }
  | {
      op: "settle_interrupt";
      sessionId: string;
      interruptId: string;
      outcome: "confirmed" | "not_aborted";
    }
  | {
      op: "claim_next_dispatch";
      sessionId: string;
      promptEntryId: string;
      stillWorking?: boolean;
    }
  | {
      op: "claim_dispatch";
      sessionId: string;
      items: DeliveryItem[];
      promptEntryId: string;
      kind?: "create";
      requireQueued?: boolean;
    }
  | { op: "ack_dispatch"; sessionId: string; promptEntryId: string }
  | { op: "fail_dispatch"; sessionId: string; promptEntryId: string };

export type DeliveryMutationReply<TResult = unknown> = {
  revision?: number;
  result: TResult;
};

export function isDeliveryReadRequest(
  request: DeliveryActorRequest,
): request is Extract<DeliveryActorRequest, { op: "snapshot" | "entries" }> {
  return request.op === "snapshot" || request.op === "entries";
}

/**
 * What a delivery operation changes in the sparse projection, as distinct from
 * whether it reads or writes the actor store.
 *
 * - `read`: no durable change.
 * - `receipt`: only the durable command journal changes. The session's
 *   delivery row, its revision and the central sparse projection are
 *   untouched, so no projection refresh or snapshot is owed.
 * - `session`: the named session's delivery row changes; refresh its sparse
 *   projection and report the new revision.
 * - `global`: every session's delivery row may change; the host refreshes
 *   each affected projection itself.
 */
export type DeliveryProjectionEffect =
  | "read"
  | "receipt"
  | "session"
  | "global";

export function deliveryProjectionEffect(
  request: DeliveryActorRequest,
): DeliveryProjectionEffect {
  switch (request.op) {
    case "snapshot":
    case "entries":
      return "read";
    case "request_submit_command":
    case "complete_submit_command":
    case "fail_submit_command":
      return "receipt";
    case "set":
    case "enqueue":
    case "promote_queued":
    case "delete":
    case "prepare_steer":
    case "accept_steer":
    case "reject_steer":
    case "requeue_steers":
    case "prepare_interrupt":
    case "begin_interrupt_effect":
    case "settle_interrupt":
    case "claim_next_dispatch":
    case "claim_dispatch":
    case "ack_dispatch":
    case "fail_dispatch":
      return "session";
    case "clear_slot":
    case "settle_pending_steers":
      return "global";
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export type DeliveryActorResult<T extends DeliveryActorRequest> = T extends {
  op: "snapshot";
}
  ? DurableDeliveryState
  : T extends { op: "entries" }
    ? Array<[string, unknown]>
    : T extends { op: "request_submit_command" }
      ? SubmitPromptCommandPlan
      : T extends { op: "complete_submit_command" }
        ? unknown
        : T extends { op: "fail_submit_command" }
          ? void
          : T extends { op: "claim_dispatch" }
            ? { promptEntryId: string; items: unknown[]; revision: number }
            : T extends { op: "claim_next_dispatch" }
              ?
                  | { kind: "empty"; revision: number }
                  | { kind: "hold"; heldCount: number; revision: number }
                  | {
                      kind: "deliver";
                      promptEntryId: string;
                      items: unknown[];
                      interrupted: boolean;
                      revision: number;
                    }
              : T extends { op: "prepare_steer" | "promote_queued" }
                ? unknown | undefined
                : T extends {
                      op:
                        | "enqueue"
                        | "delete"
                        | "ack_dispatch"
                        | "fail_dispatch"
                        | "accept_steer"
                        | "reject_steer";
                    }
                  ? boolean
                  : T extends { op: "settle_pending_steers" | "requeue_steers" }
                    ? number
                    : T extends { op: "prepare_interrupt" }
                      ? {
                          interruptId: string;
                          phase: "prepared" | "executing" | "confirmed";
                          runGeneration: number;
                          anchorId: string;
                          soloId?: string;
                        }
                      : T extends { op: "begin_interrupt_effect" }
                        ?
                            | "execute"
                            | "retry"
                            | "adopt_confirmed"
                            | "confirmed"
                            | "settled"
                        : T extends { op: "settle_interrupt" }
                          ? boolean
                          : void;
