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
import { addCollaborator, teammateName } from "../collaborators";
import { removeWorkspaceCollaborator } from "../workspaces";

const COLLABORATORS = /^\/api\/workspaces\/([^/]+)\/collaborators$/;
const COLLABORATOR = /^\/api\/workspaces\/([^/]+)\/collaborators\/([^/]+)$/;

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
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim()
        : null;
    const result = await addCollaborator(id, name, by, sessionId);
    if (!result)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
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
