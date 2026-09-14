import {
  SESSION_KERNEL_ACTOR_VERSION,
  SESSION_KERNEL_MAX_REQUEST_BYTES,
  SESSION_KERNEL_MAX_RESPONSE_BYTES,
  SESSION_KERNEL_MAX_TRANSPORT_REQUESTS,
  SESSION_KERNEL_TRANSPORT_VERSION,
  type KernelActorAsyncRequest,
  type KernelActorAsyncResponse,
  type KernelActorClientRequest,
  type KernelActorServiceCall,
  type KernelActorServiceResponse,
  type KernelActorTransportEnvelope,
} from "./server/session-kernel/actor-protocol";
import {
  readSessionKernelCredential,
  sessionKernelServiceUrl,
} from "./server/session-kernel/actor-service";

const endpoint = `${sessionKernelServiceUrl().replace(/\/$/, "")}/rpc`;
let tokenPromise: Promise<string> | undefined;
let inFlight = 0;
let serviceEpoch: string | undefined;

function sessionKernelToken(): Promise<string> {
  return (tokenPromise ??= readSessionKernelCredential());
}

class RetryableTransportError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly incarnationChanged = false,
  ) {
    super(message);
    this.name = "RetryableTransportError";
  }
}

let handshakePromise: Promise<void> | undefined;

async function exchange(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
  epoch: string | undefined,
): Promise<KernelActorServiceResponse> {
  if (inFlight >= SESSION_KERNEL_MAX_TRANSPORT_REQUESTS)
    throw new RetryableTransportError("Session kernel transport is full");
  const envelope: KernelActorTransportEnvelope = {
    version: SESSION_KERNEL_TRANSPORT_VERSION,
    actorVersion: SESSION_KERNEL_ACTOR_VERSION,
    ...(epoch ? { serviceEpoch: epoch } : {}),
    request,
  };
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > SESSION_KERNEL_MAX_REQUEST_BYTES)
    throw new Error("Session kernel request is too large");
  inFlight += 1;
  try {
    const token = await sessionKernelToken();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `Session kernel service returned ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {}
      if (response.status === 401 || response.status === 413)
        throw new Error(message);
      throw new RetryableTransportError(message, response.status === 409);
    }
    let result: KernelActorServiceResponse;
    try {
      result = JSON.parse(text) as KernelActorServiceResponse;
    } catch {
      throw new RetryableTransportError(
        "Session kernel service returned malformed JSON",
      );
    }
    if (!result || result.rpcId !== request.rpcId)
      throw new RetryableTransportError(
        "Session kernel service returned an invalid response",
      );
    if (!result.serviceEpoch)
      throw new RetryableTransportError(
        "Session kernel service omitted its incarnation fence",
      );
    if (epoch && result.serviceEpoch !== epoch)
      throw new RetryableTransportError(
        "Session kernel service returned a stale incarnation response",
        true,
      );
    return result;
  } catch (error) {
    if (error instanceof RetryableTransportError) throw error;
    if (
      error instanceof Error &&
      /credential|request is too large/i.test(error.message)
    )
      throw error;
    throw new RetryableTransportError(
      `Session kernel service request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    inFlight -= 1;
  }
}

async function ensureHandshake(): Promise<void> {
  if (serviceEpoch) return;
  if (handshakePromise) return handshakePromise;
  handshakePromise = (async () => {
    const rpcId = crypto.randomUUID();
    const result = await exchange(
      { t: "hello", rpcId, version: SESSION_KERNEL_ACTOR_VERSION },
      undefined,
    );
    if (result.t !== "ready" || !result.serviceEpoch)
      throw new RetryableTransportError(
        "Session kernel service omitted its incarnation fence",
      );
    serviceEpoch = result.serviceEpoch;
  })().finally(() => {
    handshakePromise = undefined;
  });
  return handshakePromise;
}

async function rpc(
  request: KernelActorAsyncRequest | KernelActorServiceCall,
): Promise<KernelActorServiceResponse> {
  if (request.t === "hello") {
    const result = await exchange(request, undefined);
    if (result.t !== "ready" || !result.serviceEpoch)
      throw new RetryableTransportError(
        "Session kernel service omitted its incarnation fence",
      );
    serviceEpoch = result.serviceEpoch;
    return result;
  }
  await ensureHandshake();
  const expectedEpoch = serviceEpoch!;
  try {
    return await exchange(request, expectedEpoch);
  } catch (error) {
    if (error instanceof RetryableTransportError) {
      serviceEpoch = undefined;
      // Re-establish transport for unrelated future work. The failed mutation
      // itself is not replayed here because its physical outcome may be ambiguous.
      void ensureHandshake().catch(() => {});
    }
    throw error;
  }
}

self.onmessage = (event: MessageEvent<KernelActorClientRequest>) => {
  const request = event.data;
  if (request.t === "store" || request.t === "reduce") {
    // Every gateway call carries an rpcId and settles asynchronously.
    if ("rpcId" in request) {
      const rpcId = request.rpcId;
      // One exchange per call. The actor executes the work exactly once and
      // answers under the hard response bound, so an oversized result is a
      // definitive failure body rather than a reason to repeat the query.
      const call: KernelActorServiceCall = {
        t: "call",
        rpcId,
        outputBytes: SESSION_KERNEL_MAX_RESPONSE_BYTES,
        request:
          request.t === "store"
            ? { t: "store", method: request.method, args: request.args }
            : { t: "reduce", command: request.command },
      };
      void rpc(call)
        .then((response) => {
          if (response.t !== "call_result") {
            self.postMessage({
              t: "error",
              rpcId,
              error: "Invalid kernel call response",
            } satisfies KernelActorAsyncResponse);
            return;
          }
          self.postMessage(response);
        })
        .catch((error: unknown) => {
          self.postMessage({
            t: "error",
            rpcId,
            error: error instanceof Error ? error.message : String(error),
            retryable:
              !!error &&
              typeof error === "object" &&
              (error as { retryable?: boolean }).retryable === true,
          });
        });
      return;
    }
  }
  void rpc(request).then(
    (response) => self.postMessage(response),
    (error) => {
      const reply: KernelActorAsyncResponse = {
        t: "error",
        rpcId: request.rpcId,
        error: error instanceof Error ? error.message : String(error),
        retryable:
          !!error &&
          typeof error === "object" &&
          (error as { retryable?: boolean }).retryable === true,
      };
      self.postMessage(reply);
    },
  );
};
