const { validateIntent, executeIntent } = require("./onepassword");

function reviewOptions(record, origin) {
  const intent = validateIntent(record.intent);
  const body =
    intent.body === undefined
      ? "None"
      : JSON.stringify(intent.body).replace(
          /[\u007f-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
  return {
    type: "warning",
    title: "1Password request",
    message: "Use one 1Password secret?",
    detail: [
      `Open Session: ${origin}`,
      `Session: ${record.sessionId}`,
      `Requested by: ${record.login}`,
      "",
      `Purpose: ${intent.purpose}`,
      `1Password account: ${intent.account}`,
      `Single field: ${intent.reference}`,
      "",
      `${intent.method} ${intent.url}`,
      `Secret header: ${intent.injection === "bearer" ? "Authorization: Bearer" : "x-api-key"}`,
      `JSON body (quoted): ${body}`,
      "",
      "Approve only a destination you trust with this secret. The Mac sends the field directly to this URL once. Redirects are not followed.",
      "Only the HTTP status returns to the agent. The secret, response body and headers never go to Open Session or the AI provider.",
      "1Password may separately authorize account access. This approval still reads only the field above.",
    ].join("\n"),
    buttons: ["Decline", "Approve once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

// Only a native menu click calls review(). There is no renderer IPC for reading
// secrets or invoking this approval UI. Dependencies make the whole chain
// testable without a real account, network request, or 1Password installation.
class OnePasswordReview {
  constructor({
    dialog,
    context,
    approve = (target, options) => dialog.showMessageBox(target, options),
    execute = executeIntent,
  }) {
    this.dialog = dialog;
    this.context = context;
    this.execute = execute;
    this.approve = approve;
    this.busy = false;
  }

  async review(target) {
    if (this.busy) return;
    this.busy = true;
    try {
      const current = this.context(target);
      if (!current) {
        await this.dialog.showMessageBox(target, {
          message: "Open a session first",
          detail:
            "View the requesting session in the Mac app, then choose Review 1Password request again.",
        });
        return;
      }
      const { origin, sessionId, pageUrl } = current;
      const stillHere = () => {
        const next = this.context(target);
        return next?.pageUrl === pageUrl && next?.origin === origin;
      };
      const api = async (route, body) => {
        const response = await target.webContents.session.fetch(
          `${origin}/api/onepassword/${route}`,
          {
            method: body === undefined ? "GET" : "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) throw new Error("Request unavailable");
        return response.json();
      };
      const { request } = await api(
        `pending?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!stillHere()) return;
      if (!request) {
        await this.dialog.showMessageBox(target, {
          message: "No pending 1Password request",
          detail:
            "Requests expire after 10 minutes and are visible only to the signed-in teammate who prompted the agent.",
        });
        return;
      }
      if (
        request.sessionId !== sessionId ||
        !/^[a-f0-9-]{36}$/.test(request.id) ||
        typeof request.login !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(request.login) ||
        !Number.isFinite(request.expiresAt) ||
        request.expiresAt <= Date.now()
      )
        throw new Error("Invalid request");
      const intent = validateIntent(request.intent);
      const { response } = await this.approve(
        target,
        reviewOptions({ ...request, intent }, origin),
      );
      if (!stillHere() || request.expiresAt <= Date.now()) return;
      const { claim } = await api(`${request.id}/claim`, {});
      if (typeof claim !== "string" || !/^[a-f0-9-]{36}$/.test(claim))
        throw new Error("Invalid claim");
      // Navigation, sign-out, or expiry while claiming must not unlock 1Password.
      const outcome =
        response === 1 && stillHere() && request.expiresAt > Date.now()
          ? await this.execute(intent)
          : { status: "declined" };
      // executeIntent returns only a closed result shape. Never attach an error,
      // CLI output, response text, or any part of the secret to this POST.
      await api(`${request.id}/complete`, { claim, outcome });
      if (stillHere())
        await this.dialog.showMessageBox(target, {
          message:
            outcome.status === "completed"
              ? `Request finished (HTTP ${outcome.httpStatus})`
              : outcome.status === "declined"
                ? "Request declined"
                : "Request failed",
          detail:
            outcome.status === "failed"
              ? "Check that the op CLI is installed and 1Password → Settings → Developer → Integrate with 1Password CLI is enabled. Access may also have been cancelled, or the destination may be unavailable. The request is spent; no automatic retry was made."
              : "No secret or response content was sent to the agent.",
        });
    } catch {
      if (target && !target.isDestroyed())
        await this.dialog.showMessageBox(target, {
          message: "1Password request unavailable",
          detail:
            "Check your Open Session sign-in and connection. The request may have expired or been reviewed on another Mac. If execution already started, it will not be retried automatically.",
        });
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { OnePasswordReview, reviewOptions };
