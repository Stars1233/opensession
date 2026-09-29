/**
 * Pending register_credential requests, per session (opensession-keychain).
 *
 * Fed by the session subscription (useSessionViewerSubscription) with the
 * two socket frames, and read by CredentialRegistrationCard through
 * useSyncExternalStore. The frames carry metadata only and no viewer
 * identity, so every new request re-asks the server whether this viewer may
 * answer it. The secret never passes through here.
 */
import { BASE_PATH } from "./base";
import type { WSServerMessage } from "./types";

export type CredentialRequest = NonNullable<
  Extract<
    WSServerMessage,
    { type: "credential_registration_request" }
  >["credentialRequest"]
>;

export type OpenCredentialRequest = {
  request: CredentialRequest;
  canAnswer: boolean;
};

const open = new Map<string, OpenCredentialRequest | null>();
const listeners = new Map<string, Set<() => void>>();
/** Bumped per load, so a slow response cannot overwrite a newer one. */
const loads = new Map<string, number>();

function set(sessionId: string, value: OpenCredentialRequest | null): void {
  open.set(sessionId, value);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function load(sessionId: string): void {
  const token = (loads.get(sessionId) ?? 0) + 1;
  loads.set(sessionId, token);
  fetch(
    `${BASE_PATH}/api/keychain/registrations?sessionId=${encodeURIComponent(sessionId)}`,
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body || loads.get(sessionId) !== token) return;
      set(
        sessionId,
        body.request
          ? { request: body.request, canAnswer: !!body.canAnswer }
          : null,
      );
    })
    .catch(() => {});
}

/**
 * The first viewer of a session loads what is already open: the broadcast
 * only reaches viewers who were connected when it went out. React may
 * resubscribe on a render (a new subscribe function in dev builds), so the
 * teardown is deferred a microtask and a resubscribe keeps the loaded state
 * instead of fetching again.
 */
export function subscribeCredentialRegistration(
  sessionId: string,
  listener: () => void,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  if (!set.size && !open.has(sessionId) && !loads.has(sessionId))
    load(sessionId);
  set.add(listener);
  return () => {
    set.delete(listener);
    queueMicrotask(() => {
      if (set.size || listeners.get(sessionId) !== set) return;
      listeners.delete(sessionId);
      open.delete(sessionId);
      loads.delete(sessionId);
    });
  };
}

export function credentialRegistrationFor(
  sessionId: string,
): OpenCredentialRequest | null {
  return open.get(sessionId) ?? null;
}

export function applyCredentialRegistrationFrame(
  msg: Extract<
    WSServerMessage,
    {
      type:
        | "credential_registration_request"
        | "credential_registration_resolved";
    }
  >,
): void {
  if (!listeners.has(msg.sessionId)) return;
  if (msg.type === "credential_registration_request") {
    if (msg.credentialRequest) load(msg.sessionId);
    else set(msg.sessionId, null);
  } else if (open.get(msg.sessionId)?.request.id === msg.requestId) {
    loads.set(msg.sessionId, (loads.get(msg.sessionId) ?? 0) + 1);
    set(msg.sessionId, null);
  }
}
