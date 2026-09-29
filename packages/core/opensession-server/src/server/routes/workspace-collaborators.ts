/**
 * Workspace collaborators: add a teammate to a workspace so it files into
 * their sidebar the way it does for its creator, and tell them once.
 *
 * `POST /api/workspaces/:id/collaborators` `{ name, sessionId?, user? }` adds
 * one person. Only the first add notifies: an inbox notification and a
 * mention badge on the session it was added from, which clears when they open
 * it. Adding someone already listed changes nothing and sends nothing.
 *
 * `DELETE /api/workspaces/:id/collaborators/:name` removes one person.
 *
 * Its own module so the collaborator path family is matched before the
 * generic `/api/workspaces/:id` PATCH/DELETE in workspace.ts.
 */

import { requestUser, type RouteContext } from "./context";
import { addMention } from "../mentions";
import { teamDirectory } from "../people";
import {
  addWorkspaceCollaborator,
  removeWorkspaceCollaborator,
  type Workspace,
} from "../workspaces";

const COLLABORATORS = /^\/api\/workspaces\/([^/]+)\/collaborators$/;
const COLLABORATOR = /^\/api\/workspaces\/([^/]+)\/collaborators\/([^/]+)$/;

/** The directory's first name for `name`, or null when it is not a teammate. */
function teammateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return (
    teamDirectory().find((person) => person.name.toLowerCase() === key)?.name ??
    null
  );
}

async function notifyCollaborator(
  workspace: Workspace,
  name: string,
  by: string,
  sessionId: string | null,
): Promise<void> {
  const preview = `${by} added you as a collaborator`;
  if (sessionId) {
    const mention = await addMention(name, {
      sessionId,
      by,
      source: "collaborator",
      preview,
    });
    if (mention) {
      const { broadcastToAll } = await import("../ws-hub");
      broadcastToAll({ type: "mention", user: name, mention });
    }
  }
  const { notifyUser } = await import("../notifications");
  await notifyUser(name, {
    kind: "collaborator",
    subject: { type: "workspace", id: workspace.id, title: workspace.name },
    reason: `${by} added you to ${workspace.name}`,
    body: "It's in your sidebar now.",
    actor: by,
    url: sessionId
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/workspace/${encodeURIComponent(workspace.id)}`,
  });
}

export async function handleWorkspaceCollaboratorRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  const add = path.match(COLLABORATORS);
  if (add && req.method === "POST") {
    const id = decodeURIComponent(add[1]!);
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      sessionId?: unknown;
      user?: unknown;
    };
    const name = teammateName(body.name);
    if (!name)
      return Response.json({ error: "Unknown teammate" }, { status: 400 });
    const by = requestUser(ctx, body.user).slice(0, 64) || "Someone";
    const result = await addWorkspaceCollaborator(id, name, by);
    if (!result)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    // Adding yourself puts it in your sidebar; there is nobody to tell.
    if (result.added && name.toLowerCase() !== by.toLowerCase()) {
      const sessionId =
        typeof body.sessionId === "string" && body.sessionId.trim()
          ? body.sessionId.trim()
          : null;
      // Best-effort: a push or badge hiccup must not undo the add.
      void notifyCollaborator(result.workspace, name, by, sessionId).catch(
        (error) =>
          console.warn(
            `[collaborators] notifying ${name} failed:`,
            error instanceof Error ? error.message : String(error),
          ),
      );
    }
    return Response.json({
      workspace: result.workspace,
      added: result.added,
    });
  }

  const remove = path.match(COLLABORATOR);
  if (remove && req.method === "DELETE") {
    const id = decodeURIComponent(remove[1]!);
    const name = decodeURIComponent(remove[2]!);
    const workspace = await removeWorkspaceCollaborator(id, name);
    if (!workspace)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    return Response.json({ workspace });
  }

  return undefined;
}
