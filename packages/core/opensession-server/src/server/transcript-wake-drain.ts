/**
 * Single-owner drain of the actor's durable pending transcript wake.
 *
 * Every committed transcript mutation records a durable wake (cursor,
 * unpublished change span, reset epoch) inside the actor and returns the
 * cursor it must see acknowledged. The gateway publishes the span on the
 * in-process bus and acks the cursor. Without an owner, overlapping callers
 * each read, publish and ack the same span. This module gives each canonical
 * session at most one in-flight drain per process:
 *
 * - A caller requires a cursor. It resolves once this process durably acked
 *   that cursor or higher, or once a pending read issued after the caller
 *   registered observed no pending work at all.
 * - A caller arriving during a running drain joins it. Because `ack_wake`
 *   only succeeds while the durable cursor still equals the acked cursor, a
 *   mutation committed during publication rejects the ack; the owner
 *   re-reads and drains the extended span instead of returning early.
 * - A failure rejects every waiting caller, releases the local owner and
 *   leaves the durable wake untouched: the next mutation retries it, and a
 *   crash still replays it at startup (at-least-once publication).
 *
 * The durable wake row is the only authority. Local state exists only while
 * an owner runs and is discarded afterwards, so the bus never becomes a replay
 * buffer and a restarted process trusts nothing but the store.
 */
import type { SeqEntry, TranscriptBusEvent } from "./transcript-bus";
import type { TranscriptWake } from "./session-kernel/transcript-protocol";

export type TranscriptWakeDrainPage = {
  entries: SeqEntry[];
  firstSeq: number;
  lastSeq: number;
};

export type TranscriptWakeDrainOps = {
  pendingWake(sessionId: string): Promise<TranscriptWake | null>;
  changesSince(
    sessionId: string,
    changeSeq: number,
  ): Promise<TranscriptWakeDrainPage>;
  ackWake(sessionId: string, cursor: number): Promise<boolean>;
  publish(sessionId: string, event: TranscriptBusEvent): void;
  appendHook(sessionId: string, entries: SeqEntry[]): void;
};

type Waiter = {
  /** Exact mutation cursor to cover, or 0 for "whatever is pending now". */
  cursor: number;
  /** Pending reads started before this waiter registered cannot vouch for
   * it; only a read issued at or after this generation can. A positive
   * cursor is additionally covered by any successful ack at or above it. */
  generation: number;
  resolve(drained: boolean): void;
  reject(error: unknown): void;
};

type SessionDrain = {
  owner: Promise<void> | null;
  /** Highest cursor this owner durably acked; null before the first ack. */
  acked: number | null;
  /** Bumped every time the owner issues a pending read. */
  readGeneration: number;
  waiters: Waiter[];
};

export type TranscriptWakeDrainer = {
  /**
   * Publish and ack the durable pending wake until `cursor` is covered.
   * `cursor` 0 drains whatever is pending at the call. Resolves `true` when
   * an ack covering this caller happened in this process, `false` when a
   * read found nothing pending for it.
   */
  require(sessionId: string, cursor: number): Promise<boolean>;
};

function covered(waiter: Waiter, wake: TranscriptWake, generation: number) {
  // A zero-cursor caller asked for everything pending at registration; an
  // ack for a span read before it registered proves nothing about work that
  // committed in between, so it waits for a read of its own generation.
  return waiter.cursor > 0
    ? waiter.cursor <= wake.cursor
    : waiter.generation <= generation;
}

export function createTranscriptWakeDrainer(
  ops: TranscriptWakeDrainOps,
): TranscriptWakeDrainer {
  const sessions = new Map<string, SessionDrain>();

  function settle(
    state: SessionDrain,
    predicate: (waiter: Waiter) => boolean,
    drained: boolean,
  ): void {
    const remaining: Waiter[] = [];
    for (const waiter of state.waiters) {
      if (predicate(waiter)) waiter.resolve(drained);
      else remaining.push(waiter);
    }
    state.waiters = remaining;
  }

  async function publishWake(
    sessionId: string,
    wake: TranscriptWake,
  ): Promise<void> {
    const reset = wake.resetEpoch > wake.ackedResetEpoch;
    let changeSeq = Math.max(0, wake.firstChangeSeq - 1);
    let published = false;
    while (changeSeq < wake.lastChangeSeq) {
      const page = await ops.changesSince(sessionId, changeSeq);
      if (page.entries.length === 0) break;
      ops.publish(sessionId, {
        entries: page.entries,
        firstSeq: page.firstSeq,
        lastSeq: page.lastSeq,
        ...(reset && !published ? { reset: true } : {}),
      });
      ops.appendHook(sessionId, page.entries);
      published = true;
      const next = Math.max(
        ...page.entries.map((entry) => entry.changeSeq ?? 0),
      );
      if (next <= changeSeq) break;
      changeSeq = next;
    }
    if (!published)
      ops.publish(sessionId, {
        entries: [],
        firstSeq: 0,
        lastSeq: 0,
        ...(reset ? { reset: true } : {}),
      });
  }

  async function run(sessionId: string, state: SessionDrain): Promise<void> {
    let rejectedCursor: number | null = null;
    try {
      while (state.waiters.length > 0) {
        const generation = ++state.readGeneration;
        const wake = await ops.pendingWake(sessionId);
        if (!wake) {
          // Nothing pending as of this read: every caller registered before
          // the read started is covered. Later arrivals need a fresh read.
          settle(state, (waiter) => waiter.generation <= generation, false);
          continue;
        }
        await publishWake(sessionId, wake);
        if (await ops.ackWake(sessionId, wake.cursor)) {
          rejectedCursor = null;
          state.acked = Math.max(state.acked ?? 0, wake.cursor);
          settle(state, (waiter) => covered(waiter, wake, generation), true);
          continue;
        }
        // The durable cursor moved past the span just published (a mutation
        // landed during publication) or another ack already covered it.
        // Re-read; the same rejected cursor twice means the ack can never
        // succeed, which must surface instead of spinning.
        if (rejectedCursor === wake.cursor)
          throw new Error(
            `transcript wake ack rejected twice for ${sessionId} at cursor ${wake.cursor}`,
          );
        rejectedCursor = wake.cursor;
      }
    } catch (error) {
      const waiters = state.waiters;
      state.waiters = [];
      for (const waiter of waiters) waiter.reject(error);
    }
  }

  function own(sessionId: string, state: SessionDrain): void {
    state.owner = run(sessionId, state).finally(() => {
      state.owner = null;
      // A caller that registered between the loop exiting and this callback
      // (a resolved waiter immediately mutating again) must not strand.
      if (state.waiters.length > 0) own(sessionId, state);
      else sessions.delete(sessionId);
    });
  }

  return {
    require(sessionId, cursor) {
      let state = sessions.get(sessionId);
      if (!state) {
        state = { owner: null, acked: null, readGeneration: 0, waiters: [] };
        sessions.set(sessionId, state);
      }
      // A mutation cursor this owner already durably acked is covered. A
      // cursor of 0 asks for whatever is pending now, so it always waits for
      // a covering read or ack instead of trusting an earlier ack.
      if (cursor > 0 && state.acked !== null && cursor <= state.acked)
        return Promise.resolve(true);
      const current = state;
      return new Promise<boolean>((resolve, reject) => {
        current.waiters.push({
          cursor,
          // A read already in flight may predate this caller's commit; only
          // the next read (readGeneration + 1) can vouch for it.
          generation: current.readGeneration + 1,
          resolve,
          reject,
        });
        if (!current.owner) own(sessionId, current);
      });
    },
  };
}
