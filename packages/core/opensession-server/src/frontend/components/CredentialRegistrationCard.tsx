import { useEffect, useState } from "react";
import { ASK_CARD_SHELL } from "../lib/ask-card-classes";
import { BASE_PATH } from "../lib/base";
import { AGENT_NAME } from "../lib/brand";
import type { WSServerMessage } from "../lib/types";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type CredentialRequest = NonNullable<
  Extract<
    WSServerMessage,
    { type: "credential_registration_request" }
  >["credentialRequest"]
>;

type Open = { request: CredentialRequest; canAnswer: boolean };

/** POST an answer. Outside the component so its throws stay out of React
 *  Compiler's way. The secret is only ever in this request body. */
async function answer(
  requestId: string,
  body: { sessionId: string; secret?: string },
  decline: boolean,
): Promise<void> {
  const res = await fetch(
    `${BASE_PATH}/api/keychain/registrations/${requestId}${decline ? "/decline" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || "Couldn't save the credential");
  }
}

/**
 * The agent asked the person driving this session to add a keychain
 * credential (opensession-keychain register_credential). Every viewer sees
 * the card, but only the driver gets the field: the credential will be theirs.
 * The secret goes straight to the keychain over HTTP, never to the agent.
 */
export function CredentialRegistrationCard({
  sessionId,
}: {
  sessionId: string;
}) {
  const { addHandler } = useSessionSocket();
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    let live = true;
    // The broadcast carries no viewer identity, so every change re-asks the
    // server whether this viewer may answer.
    const load = () =>
      fetch(
        `${BASE_PATH}/api/keychain/registrations?sessionId=${encodeURIComponent(sessionId)}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (!live || !body) return;
          setOpen(
            body.request
              ? { request: body.request, canAnswer: !!body.canAnswer }
              : null,
          );
        })
        .catch(() => {});
    void load();
    const off = addHandler((message) => {
      if (
        message.type === "credential_registration_request" &&
        message.sessionId === sessionId
      ) {
        if (message.credentialRequest) void load();
        else setOpen(null);
      } else if (
        message.type === "credential_registration_resolved" &&
        message.sessionId === sessionId
      ) {
        setOpen((current) =>
          current?.request.id === message.requestId ? null : current,
        );
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, addHandler]);

  if (!open) return null;
  return (
    <RequestCard
      key={open.request.id}
      sessionId={sessionId}
      request={open.request}
      canAnswer={open.canAnswer}
    />
  );
}

function RequestCard({
  sessionId,
  request,
  canAnswer,
}: {
  sessionId: string;
  request: CredentialRequest;
  canAnswer: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(decline: boolean) {
    if (!decline && !secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await answer(
        request.id,
        decline ? { sessionId } : { sessionId, secret },
        decline,
      );
      // The resolved broadcast closes the card for every viewer.
    } catch (caught) {
      setBusy(false);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't save the credential",
      );
    }
  }

  const limits = [
    request.allowedMethods?.length ? request.allowedMethods.join(", ") : null,
    request.allowedPathPrefixes?.length
      ? request.allowedPathPrefixes.join(", ")
      : null,
  ].filter(Boolean);

  return (
    <section className={ASK_CARD_SHELL} aria-label="Credential request">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
        />
        <span className="text-label font-semibold text-dim">
          {AGENT_NAME} wants to add a credential to the keychain
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-body leading-6 text-fg [overflow-wrap:anywhere]">
          <span className="font-semibold">{request.service}</span> for{" "}
          {request.host}
        </p>
        {request.description && (
          <p className="m-0 text-supporting text-dim [overflow-wrap:anywhere]">
            {request.description}
          </p>
        )}
        {limits.length > 0 && (
          <p className="m-0 text-meta text-dim [overflow-wrap:anywhere]">
            Limited to {limits.join(" · ")}
          </p>
        )}
        <p className="m-0 text-meta text-faint">
          {canAnswer
            ? `Owned by you. Teammates' sessions must ask you before using it. ${AGENT_NAME} never sees the secret.`
            : `Waiting for ${request.owner} to add the secret.`}
        </p>
      </div>

      {canAnswer && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          <Input
            type="password"
            size="lg"
            aria-label="Secret"
            placeholder="Paste the secret"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            disabled={busy}
            onChange={(event) => setSecret(event.target.value)}
            className="phone:min-h-11"
          />
          {error && (
            <p className="m-0 text-meta text-red" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="soft"
              size="lg"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              Decline
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={busy || !secret.trim()}
            >
              Save to keychain
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
