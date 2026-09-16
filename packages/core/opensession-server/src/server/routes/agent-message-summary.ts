import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { agentMessageText } from "../../shared/agent-message";
import { transcript } from "../actor-transcript";
import { findSessionAsync } from "../session-cache";
import {
  summarizeAgentMessage,
  MAX_AGENT_MESSAGE_SUMMARY_CHARS,
} from "../agent-message-summary";
import { requestUser, type RouteContext } from "./context";

type SummarySession = { id: string; accessScope?: { kind: string } };
interface Dependencies {
  session: (id: string) => Promise<SummarySession | undefined>;
  entry: (
    sessionId: string,
    entryId: string,
  ) => Promise<TranscriptEntry | null>;
  summarize: typeof summarizeAgentMessage;
}
const defaults: Dependencies = {
  session: findSessionAsync,
  entry: (sessionId, entryId) => transcript.getFullEntry(sessionId, entryId),
  summarize: summarizeAgentMessage,
};

/** A derived view of one stored correspondence entry, never a general model proxy. */
export async function handleAgentMessageSummaryRoutes(
  ctx: RouteContext,
  deps = defaults,
): Promise<Response | undefined> {
  const match = /^\/api\/sessions\/([^/]+)\/entry\/([^/]+)\/summary$/.exec(
    ctx.path,
  );
  if (!match || ctx.req.method !== "POST") return undefined;
  const headers = { "Cache-Control": "private, no-store" };
  const missing = () =>
    Response.json({ error: "Message not found" }, { status: 404, headers });
  let requestedId: string;
  let entryId: string;
  try {
    requestedId = decodeURIComponent(match[1]!);
    entryId = decodeURIComponent(match[2]!);
  } catch {
    return missing();
  }
  const session = await deps.session(requestedId);
  // The shared one-shot pool must never receive private-session material.
  const shared = (row: SummarySession | undefined) =>
    row && (!row.accessScope || row.accessScope.kind === "shared");
  if (!shared(session)) return missing();
  const sessionId = session!.id;
  const entry = await deps.entry(sessionId, entryId);
  const content = entry && agentMessageText(entry);
  if (!content?.trim() || !shared(await deps.session(sessionId)))
    return missing();
  // Demo verification must not spend a real model turn.
  const summary =
    process.env.OPENSESSION_DEMO === "1"
      ? null
      : await deps.summarize(
          sessionId,
          entryId,
          content,
          requestUser(ctx) || undefined,
        );
  if (!shared(await deps.session(sessionId))) return missing();
  return Response.json(
    {
      summary,
      ...(content.length > MAX_AGENT_MESSAGE_SUMMARY_CHARS
        ? { partial: true }
        : {}),
    },
    { headers },
  );
}
