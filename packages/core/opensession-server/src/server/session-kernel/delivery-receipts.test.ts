import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Isolated state must be in place before any kernel module resolves its paths.
const stateDir = mkdtempSync(join(tmpdir(), "opensession-delivery-receipts-"));
const centralPath = join(stateDir, "session-kernel.sqlite");
const previousEnv = {
  stateDir: process.env.OPENSESSION_STATE_DIR,
  databasePath: process.env.OPENSESSION_SESSION_KERNEL_DB_PATH,
};
process.env.OPENSESSION_STATE_DIR = stateDir;
process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = centralPath;

const { SessionKernelActorClient, SessionKernelQuarantinedError } =
  await import("./actor-client");
const { isReadReducer } = await import("./actor-routing");
const { deliveryProjectionEffect, isDeliveryReadRequest } =
  await import("./delivery-protocol");
const {
  installSessionKernelActor,
  sessionDelivery,
  sessionDeliveryProjectionCached,
} = await import("./kernel");
type DeliveryActorRequest = import("./delivery-protocol").DeliveryActorRequest;
type DeliveryMutationReply<T> =
  import("./delivery-protocol").DeliveryMutationReply<T>;
type DurableDeliveryState = import("./store").DurableDeliveryState;
type SessionKernelActorClient = InstanceType<typeof SessionKernelActorClient>;

afterAll(() => {
  if (previousEnv.stateDir === undefined)
    delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousEnv.stateDir;
  if (previousEnv.databasePath === undefined)
    delete process.env.OPENSESSION_SESSION_KERNEL_DB_PATH;
  else
    process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = previousEnv.databasePath;
  rmSync(stateDir, { recursive: true, force: true });
});

/** `expect(promise).rejects` on a pending Worker call stalls that Worker's
 * reply under bun test, so settle the call first and assert on it after. */
function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => {},
    () => {},
  );
}

const sessionId = "receipt-session";
const target = { runId: "run-1", generation: 1, token: "steer-token" };

/** One request per delivery op; the switch in `deliveryProjectionEffect` keeps
 * this list honest because an unlisted op fails to type-check there. */
const everyDeliveryRequest: DeliveryActorRequest[] = [
  { op: "snapshot", sessionId },
  { op: "entries", slot: "queued" },
  { op: "request_submit_command", sessionId, requestId: "r", identity: {} },
  { op: "complete_submit_command", sessionId, requestId: "r", result: {} },
  { op: "fail_submit_command", sessionId, requestId: "r", error: "x" },
  { op: "set", sessionId, slot: "queued", value: [] },
  { op: "enqueue", sessionId, item: { id: "i" } },
  { op: "promote_queued", sessionId, itemId: "i", promptEntryId: "p" },
  { op: "delete", sessionId, slot: "queued" },
  { op: "clear_slot", slot: "queued" },
  { op: "prepare_steer", sessionId, itemId: "i", target },
  { op: "accept_steer", sessionId, itemId: "i", target },
  { op: "reject_steer", sessionId, itemId: "i", target },
  { op: "settle_pending_steers" },
  { op: "requeue_steers", sessionId, items: [] },
  {
    op: "prepare_interrupt",
    sessionId,
    interruptId: "int",
    anchorId: "a",
    dispatchId: "d",
  },
  {
    op: "begin_interrupt_effect",
    sessionId,
    interruptId: "int",
    runGeneration: 1,
  },
  {
    op: "settle_interrupt",
    sessionId,
    interruptId: "int",
    outcome: "confirmed",
  },
  { op: "claim_next_dispatch", sessionId, promptEntryId: "p" },
  { op: "claim_dispatch", sessionId, items: [], promptEntryId: "p" },
  { op: "ack_dispatch", sessionId, promptEntryId: "p" },
  { op: "fail_dispatch", sessionId, promptEntryId: "p" },
];

describe("delivery projection effect classification", () => {
  test("classifies every delivery op and keeps receipts apart from reads", () => {
    const effects = Object.fromEntries(
      everyDeliveryRequest.map((request) => [
        request.op,
        deliveryProjectionEffect(request),
      ]),
    );
    expect(effects).toEqual({
      snapshot: "read",
      entries: "read",
      request_submit_command: "receipt",
      complete_submit_command: "receipt",
      fail_submit_command: "receipt",
      set: "session",
      enqueue: "session",
      promote_queued: "session",
      delete: "session",
      clear_slot: "global",
      prepare_steer: "session",
      accept_steer: "session",
      reject_steer: "session",
      settle_pending_steers: "global",
      requeue_steers: "session",
      prepare_interrupt: "session",
      begin_interrupt_effect: "session",
      settle_interrupt: "session",
      claim_next_dispatch: "session",
      claim_dispatch: "session",
      ack_dispatch: "session",
      fail_dispatch: "session",
    });
    for (const request of everyDeliveryRequest) {
      const effect = deliveryProjectionEffect(request);
      // Read classification is unchanged: receipts still route and fence as
      // mutations; only their projection effect is narrower.
      expect(isDeliveryReadRequest(request)).toBe(effect === "read");
      expect(isReadReducer({ kind: "delivery", commandId: "c", request })).toBe(
        effect === "read",
      );
      // Every op that changes one session's row names that session so the
      // worker can refresh its projection and report the new revision.
      if (effect === "session") expect("sessionId" in request).toBe(true);
    }
  });
});

describe("gateway delivery facade", () => {
  test("a receipt costs one actor call; a queue change costs its refresh", async () => {
    const calls: DeliveryActorRequest[] = [];
    let snapshot: DurableDeliveryState = {
      revision: 3,
      queued: [{ id: "queued-one" }],
      steered: [],
      pendingSteers: [],
      updatedAt: 1,
    };
    const fakeActor = {
      decideDeliveryAsync: async (request: DeliveryActorRequest) => {
        calls.push(request);
        switch (request.op) {
          case "snapshot":
            return snapshot;
          case "request_submit_command":
            return { status: "execute" };
          case "complete_submit_command":
            return request.result;
          case "fail_submit_command":
            return undefined;
          case "enqueue":
            snapshot = {
              ...snapshot,
              revision: snapshot.revision + 1,
              queued: [...snapshot.queued, request.item],
            };
            return true;
          default:
            throw new Error(`unexpected ${request.op}`);
        }
      },
    };
    const previous = installSessionKernelActor(
      fakeActor as unknown as SessionKernelActorClient,
    );
    try {
      await sessionDelivery({ op: "snapshot", sessionId });
      const cached = sessionDeliveryProjectionCached(sessionId);
      expect(cached).toBe(snapshot);
      calls.length = 0;

      const identity = { content: "hello", attachmentsHash: "none" };
      await expect(
        sessionDelivery({
          op: "request_submit_command",
          sessionId,
          requestId: "submit-1",
          identity,
        }),
      ).resolves.toEqual({ status: "execute" });
      await expect(
        sessionDelivery({
          op: "complete_submit_command",
          sessionId,
          requestId: "submit-1",
          result: { status: "queued" },
        }),
      ).resolves.toEqual({ status: "queued" });
      await sessionDelivery({
        op: "fail_submit_command",
        sessionId,
        requestId: "submit-2",
        error: "boom",
      });
      // Exactly one actor call per receipt and no post-receipt snapshot.
      expect(calls.map((call) => call.op)).toEqual([
        "request_submit_command",
        "complete_submit_command",
        "fail_submit_command",
      ]);
      expect(sessionDeliveryProjectionCached(sessionId)).toBe(cached);

      calls.length = 0;
      await expect(
        sessionDelivery({
          op: "enqueue",
          sessionId,
          item: { id: "queued-two" },
        }),
      ).resolves.toBe(true);
      // A genuine queue change still refreshes the cached projection.
      expect(calls.map((call) => call.op)).toEqual(["enqueue", "snapshot"]);
      expect(sessionDeliveryProjectionCached(sessionId)).toMatchObject({
        revision: 4,
        queued: [{ id: "queued-one" }, { id: "queued-two" }],
      });
    } finally {
      installSessionKernelActor(previous);
    }
  });
});

describe("actor worker submit receipts", () => {
  let worker: Worker;
  let client: SessionKernelActorClient;

  beforeAll(async () => {
    worker = new Worker(
      new URL("../../session-kernel-worker.ts", import.meta.url),
      { type: "module" },
    );
    client = new SessionKernelActorClient(worker);
    await client.hello();
  });

  afterAll(() => {
    client.terminate();
  });

  function reply<T = unknown>(request: DeliveryActorRequest) {
    return client.callAsync<DeliveryMutationReply<T>>(
      {
        t: "reduce",
        command: { kind: "delivery", commandId: crypto.randomUUID(), request },
      },
      `delivery ${request.op}`,
    );
  }

  function centralRows() {
    const db = new Database(centralPath, { readonly: true });
    try {
      const projection = db
        .query(
          "SELECT dirty, delivery_state, updated_at FROM session_kernel_sparse_projections WHERE session_id = ?",
        )
        .get(sessionId) as {
        dirty: number;
        delivery_state: string | null;
        updated_at: number;
      } | null;
      const placement = db
        .query(
          "SELECT placement, needs_scan FROM session_kernel_placements WHERE session_id = ?",
        )
        .get(sessionId) as { placement: string; needs_scan: number } | null;
      return { projection, placement };
    } finally {
      db.close();
    }
  }

  function clearWake() {
    const db = new Database(centralPath);
    try {
      db.run(
        "UPDATE session_kernel_placements SET needs_scan = 0 WHERE session_id = ?",
        [sessionId],
      );
    } finally {
      db.close();
    }
  }

  test("receipts settle the command journal without touching delivery projections", async () => {
    const enqueued = await reply<boolean>({
      op: "enqueue",
      sessionId,
      item: { id: "queued-one", content: "hello" },
    });
    expect(enqueued).toEqual({ result: true, revision: 1 });
    const before = centralRows();
    expect(before.placement).toEqual({ placement: "isolated", needs_scan: 1 });
    expect(before.projection?.dirty).toBe(0);
    expect(JSON.parse(before.projection!.delivery_state!)).toMatchObject({
      revision: 1,
      queued: [{ id: "queued-one", content: "hello" }],
    });
    clearWake();
    await Bun.sleep(5);

    const identity = { content: "hello", attachmentsHash: "none" };
    const submit = {
      op: "request_submit_command",
      sessionId,
      requestId: "submit-one",
      identity,
    } as const;
    // Receipt replies carry only the result: no revision is read for them.
    expect(await reply(submit)).toEqual({ result: { status: "execute" } });
    expect(await reply(submit)).toEqual({ result: { status: "in_progress" } });
    const reused = reply({
      ...submit,
      identity: { ...identity, content: "changed" },
    });
    await settle(reused);
    await expect(reused).rejects.toThrow("reused with another payload");
    const result = { status: "queued", deliveryId: "submit-one" };
    expect(
      await reply({
        op: "complete_submit_command",
        sessionId,
        requestId: "submit-one",
        result,
      }),
    ).toEqual({ result });
    expect(await reply(submit)).toEqual({
      result: { status: "completed", result, duplicate: true },
    });
    // Settlement is idempotent and a late failure cannot undo completion.
    expect(
      await reply({
        op: "complete_submit_command",
        sessionId,
        requestId: "submit-one",
        result: { status: "ignored" },
      }),
    ).toEqual({ result });
    expect(
      await reply({
        op: "fail_submit_command",
        sessionId,
        requestId: "submit-one",
        error: "late",
      }),
    ).toEqual({ result: undefined });

    const failing = { ...submit, requestId: "submit-two" };
    expect(await reply(failing)).toEqual({ result: { status: "execute" } });
    expect(
      await reply({
        op: "fail_submit_command",
        sessionId,
        requestId: "submit-two",
        error: "boom",
      }),
    ).toEqual({ result: undefined });
    const failed = reply(failing);
    await settle(failed);
    await expect(failed).rejects.toThrow("boom");

    // The delivery row, its revision and the sparse projection are unchanged.
    const snapshot = await client.decideDeliveryAsync({
      op: "snapshot",
      sessionId,
    });
    expect(snapshot).toMatchObject({
      revision: 1,
      queued: [{ id: "queued-one", content: "hello" }],
    });
    const after = centralRows();
    expect(after.projection).toEqual(before.projection);
    // The generic runtime wake is still owed for a journal mutation.
    expect(after.placement).toEqual({ placement: "isolated", needs_scan: 1 });

    // A genuine queue change still refreshes the projection and bumps the
    // revision.
    await Bun.sleep(5);
    expect(
      await reply<boolean>({
        op: "enqueue",
        sessionId,
        item: { id: "queued-two", content: "again" },
      }),
    ).toEqual({ result: true, revision: 2 });
    const refreshed = centralRows();
    expect(refreshed.projection?.dirty).toBe(0);
    expect(refreshed.projection!.updated_at).toBeGreaterThan(
      before.projection!.updated_at,
    );
    expect(JSON.parse(refreshed.projection!.delivery_state!)).toMatchObject({
      revision: 2,
      queued: [{ id: "queued-one" }, { id: "queued-two" }],
    });
  });

  test("a rejected settlement quarantines the session and fences later receipts", async () => {
    // Completing a receipt that was never requested is a critical settlement
    // rejection, so the actor quarantines the session (unchanged behavior).
    const missing = reply({
      op: "complete_submit_command",
      sessionId,
      requestId: "submit-missing",
      result: { status: "queued" },
    });
    await settle(missing);
    await expect(missing).rejects.toThrow("receipt is missing");
    const fenced = reply({
      op: "request_submit_command",
      sessionId,
      requestId: "submit-three",
      identity: {},
    });
    await settle(fenced);
    await expect(fenced).rejects.toBeInstanceOf(SessionKernelQuarantinedError);
  });
});
