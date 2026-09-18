import { findSessionAsync } from "../session-cache";
import { mergedSessionTranscriptAsync } from "../sessions";
import { sessionVoiceContext } from "../../shared/session-voice";
import { createSessionVoiceAnswer } from "../session-voice";
import type { RouteContext } from "./context";

export async function handleSessionVoiceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const match = ctx.path.match(/^\/api\/sessions\/([^/]+)\/voice$/);
  if (!match || ctx.req.method !== "POST") return undefined;
  // Paid microphone calls require a human web identity, never a body-supplied
  // name or an agent's machine credential. Normal prompt authorization remains
  // on the existing WebSocket/outbox path, not on this speech transport.
  if (!ctx.authUser?.login)
    return Response.json(
      { error: "Sign in to start a voice call." },
      { status: 401 },
    );
  if (process.env.OPENSESSION_DEMO === "1")
    return Response.json(
      { error: "Voice calls are unavailable in the demo." },
      { status: 503 },
    );
  const body = await ctx.req.json().catch(() => null);
  if (
    typeof body?.sdp !== "string" ||
    !body.sdp.trim() ||
    body.sdp.length > 64 * 1024
  )
    return Response.json({ error: "Invalid voice offer." }, { status: 400 });
  const session = await findSessionAsync(decodeURIComponent(match[1]!));
  if (!session)
    return Response.json({ error: "Session not found." }, { status: 404 });
  if (
    (session.source !== "opensession" && session.source !== "slack") ||
    session.archived
  )
    return Response.json(
      { error: "Open an active Open Session conversation to call its agent." },
      { status: 409 },
    );
  try {
    const context = sessionVoiceContext(
      await mergedSessionTranscriptAsync(session),
    );
    const sdp = await createSessionVoiceAnswer(
      body.sdp,
      ctx.req.signal,
      context,
    );
    return Response.json({ sdp }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not start the voice call.",
      },
      { status: 502 },
    );
  }
}
