/**
 * Per-session lifecycle lane.
 *
 * Everything that reads or replaces a session's workspace as a whole runs on
 * this lane, one operation at a time, in request order: workspace
 * checkpoints, moves between machines, rebuilds, and manual sleep. Run
 * admission (run-session's `runSessionPrompt`) waits for the lane to settle
 * before a turn starts and, symmetrically, a lifecycle operation refuses
 * while a turn is admitted. A turn can therefore neither edit the tree under
 * a capture nor start against a Sandbox the operation is about to destroy,
 * and the operation's final session update lands before the turn reads the
 * session it runs in.
 *
 * The lane is claimed synchronously, before the first await, so a caller that
 * schedules an operation and returns has already made later turns wait on it.
 * It is reentrant: an operation already on a session's lane may call helpers
 * that claim the same lane (a move that checkpoints first) without waiting on
 * itself.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type LaneGlobals = {
  __osLifecycleLanes?: Map<string, Promise<void>>;
  __osLifecycleLaneHolder?: AsyncLocalStorage<string>;
};
const globals = globalThis as LaneGlobals;

/** The tail of each session's chain of operations still in flight.
 * Module-global across reloads like the other session lanes. */
const lanes: Map<string, Promise<void>> = (globals.__osLifecycleLanes ??=
  new Map());

/** The session whose lane the current async context holds, for reentrancy. */
const holder: AsyncLocalStorage<string> = (globals.__osLifecycleLaneHolder ??=
  new AsyncLocalStorage<string>());

/**
 * Run `fn` after every operation already queued for the session, or at once
 * when the caller is itself running on that session's lane.
 */
export function withSessionLifecycleLane<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (holder.getStore() === sessionId) return fn();
  const prior = lanes.get(sessionId) ?? Promise.resolve();
  const run = prior.then(() => holder.run(sessionId, fn));
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  void settled.then(() => {
    if (lanes.get(sessionId) === settled) lanes.delete(sessionId);
  });
  lanes.set(sessionId, settled);
  return run;
}

/** Resolves once no lifecycle operation is in flight for the session. Never
 * rejects: a failed operation is reported where it was requested, not to the
 * turn that merely waited for it. */
export function settleSessionLifecycle(sessionId: string): Promise<void> {
  return lanes.get(sessionId) ?? Promise.resolve();
}

/** Whether a lifecycle operation is in flight for the session right now. */
export function sessionLifecycleInFlight(sessionId: string): boolean {
  return lanes.has(sessionId);
}
