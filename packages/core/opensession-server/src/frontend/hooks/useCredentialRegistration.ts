import { useSyncExternalStore } from "react";
import {
  credentialRegistrationFor,
  subscribeCredentialRegistration,
  type OpenCredentialRequest,
} from "../lib/credential-registration-store";

/** The session's open register_credential request, if any. */
export function useCredentialRegistration(
  sessionId: string,
): OpenCredentialRequest | null {
  const snapshot = () => credentialRegistrationFor(sessionId);
  return useSyncExternalStore(
    (listener) => subscribeCredentialRegistration(sessionId, listener),
    snapshot,
    snapshot,
  );
}
