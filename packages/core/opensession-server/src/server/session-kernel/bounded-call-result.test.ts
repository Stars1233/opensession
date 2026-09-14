import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated state must be in place before any kernel module resolves its paths.
const stateDir = mkdtempSync(join(tmpdir(), "opensession-bounded-call-"));
const previousEnv = {
  stateDir: process.env.OPENSESSION_STATE_DIR,
  databasePath: process.env.OPENSESSION_SESSION_KERNEL_DB_PATH,
  token: process.env.OPENSESSION_SESSION_KERNEL_TOKEN,
  url: process.env.OPENSESSION_SESSION_KERNEL_URL,
};
process.env.OPENSESSION_STATE_DIR = stateDir;
process.env.OPENSESSION_SESSION_KERNEL_DB_PATH = join(
  stateDir,
  "worker",
  "session-kernel.sqlite",
);

const {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_RESPONSE_TOO_LARGE,
  SESSION_KERNEL_TRANSPORT_VERSION,
  boundCallResult,
} = await import("./actor-protocol");
const { SessionKernelActorClient, SessionKernelActorError } =
  await import("./actor-client");
const { startSessionKernelService } = await import("./actor-service");
type KernelActorCallResult = import("./actor-protocol").KernelActorCallResult;
type KernelActorServiceCall = import("./actor-protocol").KernelActorServiceCall;
type KernelActorTransportEnvelope =
  import("./actor-protocol").KernelActorTransportEnvelope;
type SessionKernelActorClient = InstanceType<typeof SessionKernelActorClient>;

afterAll(() => {
  for (const [key, value] of [
    ["OPENSESSION_STATE_DIR", previousEnv.stateDir],
    ["OPENSESSION_SESSION_KERNEL_DB_PATH", previousEnv.databasePath],
    ["OPENSESSION_SESSION_KERNEL_TOKEN", previousEnv.token],
    ["OPENSESSION_SESSION_KERNEL_URL", previousEnv.url],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

/** The shape every transport and client, legacy or current, settles as one
 * ordinary non-retryable failure. */
function overflowFailure(result: KernelActorCallResult, rawBytes: number) {
  expect(result.status).toBe(-1);
  expect(result.length).toBe(Buffer.byteLength(result.body));
  expect(JSON.parse(result.body)).toEqual({
    ok: false,
    error: `Session kernel result exceeds the response bound (${rawBytes} bytes)`,
    code: SESSION_KERNEL_RESPONSE_TOO_LARGE,
  });
}

const NINE_MIB = 9 * 1024 * 1024;

describe("boundCallResult", () => {
  test("returns a body whose escaped size fits the bound", () => {
    expect(boundCallResult("abc", true, 100)).toEqual({
      status: 1,
      length: 3,
      body: "abc",
    });
    expect(boundCallResult("nope", false, 100)).toEqual({
      status: -1,
      length: 4,
      body: "nope",
    });
    // Multibyte text is not escaped by JSON, so it costs its UTF-8 bytes only.
    const accented = "é".repeat(40);
    expect(boundCallResult(accented, true, 100)).toEqual({
      status: 1,
      length: 80,
      body: accented,
    });
    // Raw bytes above the fast path but escaped bytes still under the bound.
    const quoted = '"'.repeat(30);
    expect(boundCallResult(quoted, true, 100)).toEqual({
      status: 1,
      length: 30,
      body: quoted,
    });
  });

  test("replaces an oversized body with a small definitive failure", () => {
    // Raw overflow.
    overflowFailure(boundCallResult("x".repeat(101), true, 100), 101);
    // Raw bytes fit, but every quote doubles on the wire.
    overflowFailure(boundCallResult('"'.repeat(60), true, 100), 60);
    // Control characters expand sixfold.
    overflowFailure(boundCallResult("\u0001".repeat(20), true, 100), 20);
    // A failure body is bounded the same way.
    overflowFailure(boundCallResult("\\".repeat(60), false, 100), 60);
    // The replacement itself always fits the production bound.
    expect(
      Buffer.byteLength(
        JSON.stringify(
          boundCallResult(
            "x".repeat(SESSION_KERNEL_MAX_RESPONSE_BYTES + 1),
            true,
          ).body,
        ),
      ),
    ).toBeLessThan(1024);
  });
});

/** Mirrors the actor client's worker contract: one posted request, one reply. */
class FakeWorker {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly posted: Array<Record<string, any>> = [];
  constructor(
    private readonly respond: (message: Record<string, any>) => unknown,
  ) {}
  addEventListener(type: string, listener: (event: any) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  postMessage(message: Record<string, any>) {
    this.posted.push(message);
    queueMicrotask(() => {
      const data = this.respond(message);
      for (const listener of this.listeners.get("message") ?? [])
        listener({ data });
    });
  }
  terminate() {}
}

describe("actor client overflow handling", () => {
  test("settles the overflow failure once without retrying the read", async () => {
    const overflow = boundCallResult("x".repeat(200), true, 100);
    const worker = new FakeWorker((message) => ({
      t: "call_result",
      rpcId: message.rpcId,
      ...overflow,
    }));
    const client = new SessionKernelActorClient(worker as unknown as Worker);
    try {
      const attempt = client.callAsync(
        { t: "store", method: "deliverySnapshot", args: ["overflow"] },
        "deliverySnapshot",
      );
      await settle(attempt);
      await expect(attempt).rejects.toBeInstanceOf(SessionKernelActorError);
      await expect(attempt).rejects.toMatchObject({
        retryable: false,
        message: "Session kernel result exceeds the response bound (200 bytes)",
      });
      // A read would be retried on a retryable failure; this one is not.
      expect(worker.posted).toHaveLength(1);
    } finally {
      client.terminate();
    }
  });

  test("a legacy bodyless status 2 fails definitively without a retry", async () => {
    const worker = new FakeWorker((message) => ({
      t: "call_result",
      rpcId: message.rpcId,
      status: 2,
      length: SESSION_KERNEL_MAX_RESPONSE_BYTES + 1,
    }));
    const client = new SessionKernelActorClient(worker as unknown as Worker);
    try {
      const attempt = client.callAsync(
        { t: "store", method: "changesSince", args: ["legacy", 0] },
        "changesSince",
      );
      await settle(attempt);
      await expect(attempt).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining("exceeds the response bound"),
      });
      expect(worker.posted).toHaveLength(1);
    } finally {
      client.terminate();
    }
  });
});

function bigDelivery(sessionId: string) {
  return {
    op: "set" as const,
    sessionId,
    slot: "queued" as const,
    value: [{ id: "large", content: "x".repeat(NINE_MIB) }],
  };
}

describe("actor worker response bound", () => {
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

  // This proves the reply shape only: a read far above the old 256 KiB first
  // pass arrives whole, in one message. Execute-once is established by the
  // service test below, whose 1 KiB hint would have produced a bodyless
  // status 2 from a negotiating actor, and by the transport exchange counts.
  test("answers a large direct read above the old first-pass hint in one reply", async () => {
    const sessionId = "direct-large-read";
    await client.decideDeliveryAsync(bigDelivery(sessionId));
    const messages: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      worker.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as Record<string, unknown>;
        if (data.rpcId !== "direct-large-read-rpc") return;
        messages.push(data);
        resolve();
      });
    });
    worker.postMessage({
      t: "reduce",
      rpcId: "direct-large-read-rpc",
      command: {
        kind: "delivery",
        commandId: "direct-large-read-rpc",
        request: { op: "snapshot", sessionId },
      },
    });
    await done;
    await Bun.sleep(20);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ t: "call_result", status: 1 });
    expect(messages[0]!.length as number).toBeGreaterThan(NINE_MIB);
    expect(
      JSON.parse(messages[0]!.body as string).result.queued[0].content,
    ).toHaveLength(NINE_MIB);
  });
});

describe("service response bound", () => {
  const token = "test-bounded-call-token";
  let service: Awaited<ReturnType<typeof startSessionKernelService>>;
  let serviceEpoch: string | undefined;

  beforeAll(async () => {
    service = await startSessionKernelService({
      port: 0,
      token,
      workerCount: 2,
      databasePath: join(stateDir, "service", "session-kernel.sqlite"),
    });
  });

  afterAll(() => {
    service.stop();
  });

  async function rpc(request: KernelActorTransportEnvelope["request"]) {
    if (!serviceEpoch && request.t !== "hello") {
      const ready = await rpc({
        t: "hello",
        rpcId: "bounded-handshake",
        version: SESSION_KERNEL_ACTOR_VERSION,
      });
      serviceEpoch = ready.serviceEpoch as string;
    }
    const response = await fetch(`${service.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: SESSION_KERNEL_TRANSPORT_VERSION,
        actorVersion: SESSION_KERNEL_ACTOR_VERSION,
        ...(serviceEpoch ? { serviceEpoch } : {}),
        request,
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, any>;
  }

  test("a large read is answered in one exchange regardless of the advisory bound", async () => {
    const sessionId = "service-large-read";
    const seeded = await rpc({
      t: "call",
      rpcId: "seed-service-large-read",
      outputBytes: 1024,
      request: {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: "seed-service-large-read",
          request: bigDelivery(sessionId),
        },
      },
    });
    expect(seeded).toMatchObject({ t: "call_result", status: 1 });
    // 1 KiB used to force a status 2 and a second, larger execution.
    const read = await rpc({
      t: "call",
      rpcId: "service-large-read",
      outputBytes: 1024,
      request: { t: "store", method: "deliverySnapshot", args: [sessionId] },
    });
    expect(read).toMatchObject({ t: "call_result", status: 1 });
    expect(read.length).toBeGreaterThan(NINE_MIB);
    expect(JSON.parse(read.body).result.queued[0].content).toHaveLength(
      NINE_MIB,
    );
    // The compatibility field is still validated against the hard bound.
    expect(
      await rpc({
        t: "call",
        rpcId: "service-invalid-bound",
        outputBytes: SESSION_KERNEL_MAX_RESPONSE_BYTES + 1,
        request: { t: "store", method: "deliverySnapshot", args: [sessionId] },
      }),
    ).toMatchObject({
      t: "error",
      error: "Invalid kernel actor response bound",
    });
  }, 15_000);
});

describe("transport worker response bound", () => {
  const token = "test-transport-bound-token";
  const exchanges = new Map<string, KernelActorServiceCall[]>();
  const callKey = (call: KernelActorServiceCall) =>
    call.request.t === "store"
      ? call.request.method
      : `${call.request.command.kind}:${"request" in call.request.command ? call.request.command.request.op : "event"}`;
  let server: ReturnType<typeof Bun.serve>;
  let worker: Worker;
  let client: SessionKernelActorClient;

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const envelope = (await request.json()) as KernelActorTransportEnvelope;
        const serviceEpoch = "transport-bound-epoch";
        if (envelope.request.t === "hello")
          return Response.json({
            t: "ready",
            rpcId: envelope.request.rpcId,
            version: SESSION_KERNEL_ACTOR_VERSION,
            serviceEpoch,
          });
        if (envelope.request.t !== "call")
          return Response.json({ error: "unexpected" }, { status: 500 });
        const call = envelope.request;
        const key = callKey(call);
        exchanges.set(key, [...(exchanges.get(key) ?? []), call]);
        const rpcId = call.rpcId;
        if (key === "deliverySnapshot") {
          const body = JSON.stringify({
            ok: true,
            result: { queued: [{ content: "x".repeat(NINE_MIB) }] },
          });
          return Response.json({
            t: "call_result",
            rpcId,
            status: 1,
            length: Buffer.byteLength(body),
            body,
            serviceEpoch,
          });
        }
        // A legacy actor reported an oversized read as a bodyless status 2.
        if (key === "runState")
          return Response.json({
            t: "call_result",
            rpcId,
            status: 2,
            length: SESSION_KERNEL_MAX_RESPONSE_BYTES + 1,
            serviceEpoch,
          });
        // Everything else is "materialized but over the hard bound".
        return Response.json({
          t: "call_result",
          rpcId,
          ...boundCallResult(
            "x".repeat(SESSION_KERNEL_MAX_RESPONSE_BYTES + 1),
            true,
          ),
          serviceEpoch,
        });
      },
    });
    process.env.OPENSESSION_SESSION_KERNEL_TOKEN = token;
    process.env.OPENSESSION_SESSION_KERNEL_URL = server.url.origin;
    worker = new Worker(
      new URL("../../session-kernel-transport-worker.ts", import.meta.url),
      { type: "module" },
    );
    client = new SessionKernelActorClient(worker);
    await client.hello();
  });

  afterAll(() => {
    client.terminate();
    server.stop(true);
  });

  test("a large read is one exchange under the hard bound", async () => {
    const result = await client.callAsync<{
      queued: Array<{ content: string }>;
    }>(
      { t: "store", method: "deliverySnapshot", args: ["transport-large"] },
      "deliverySnapshot",
    );
    expect(result.queued[0]!.content).toHaveLength(NINE_MIB);
    const calls = exchanges.get("deliverySnapshot") ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.outputBytes).toBe(SESSION_KERNEL_MAX_RESPONSE_BYTES);
  });

  test("an oversized read fails definitively instead of being re-run", async () => {
    const attempt = client.callAsync(
      { t: "store", method: "changesSince", args: ["transport-over", 0] },
      "changesSince",
    );
    await settle(attempt);
    await expect(attempt).rejects.toBeInstanceOf(SessionKernelActorError);
    await expect(attempt).rejects.toMatchObject({
      retryable: false,
      message: `Session kernel result exceeds the response bound (${SESSION_KERNEL_MAX_RESPONSE_BYTES + 1} bytes)`,
    });
    expect(exchanges.get("changesSince")).toHaveLength(1);
  });

  test("a legacy status 2 read fails definitively instead of being re-run", async () => {
    const attempt = client.callAsync(
      { t: "store", method: "runState", args: ["transport-legacy"] },
      "runState",
    );
    await settle(attempt);
    await expect(attempt).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("exceeds the response bound"),
    });
    expect(exchanges.get("runState")).toHaveLength(1);
  });

  test("an oversized mutation result is never replayed", async () => {
    const attempt = client.decideDeliveryAsync({
      op: "enqueue",
      sessionId: "transport-mutation",
      item: { id: "never-replayed" },
    });
    await settle(attempt);
    await expect(attempt).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("exceeds the response bound"),
    });
    expect(exchanges.get("delivery:enqueue")).toHaveLength(1);
  });
});
