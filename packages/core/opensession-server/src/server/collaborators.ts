/**
 * Workspace collaborators: add a teammate to a workspace so it files into
 * their sidebar the way it does for its creator, and tell them once.
 *
 * Shared by the `/api/workspaces/:id/collaborators` routes and the
 * opensession-sessions MCP tools. Only the first add notifies: an inbox
 * notification and, when it was added from a session, a mention badge there
 * that clears when they open it. Adding someone already listed changes
 * nothing and sends nothing.
 */

import { addMention } from "./mentions";
import { teamDirectory } from "./people";
import { addWorkspaceCollaborator, type Workspace } from "./workspaces";

/** The directory's first name for `name`, or null when it is not a teammate.
 *  Matches first name, full name, or GitHub login, case-insensitively. */
export function teammateName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return (
    teamDirectory().find(
      (person) =>
        person.name.toLowerCase() === key ||
        person.fullName.toLowerCase() === key ||
        person.github?.toLowerCase() === key,
    )?.name ?? null
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
      const { broadcastToAll } = await import("./ws-hub");
      broadcastToAll({ type: "mention", user: name, mention });
    }
  }
  const { notifyUser } = await import("./notifications");
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

/**
 * Add `name` (already resolved with `teammateName`) to a workspace and notify
 * them on the first add. Null when the workspace does not exist.
 */
export async function addCollaborator(
  workspaceId: string,
  name: string,
  by: string,
  sessionId: string | null,
): Promise<{ workspace: Workspace; added: boolean } | null> {
  const result = await addWorkspaceCollaborator(workspaceId, name, by);
  if (!result) return null;
  // Adding yourself puts it in your sidebar; there is nobody to tell.
  if (result.added && name.toLowerCase() !== by.toLowerCase()) {
    // Best-effort: a push or badge hiccup must not undo the add.
    void notifyCollaborator(result.workspace, name, by, sessionId).catch(
      (error) =>
        console.warn(
          `[collaborators] notifying ${name} failed:`,
          error instanceof Error ? error.message : String(error),
        ),
    );
  }
  return result;
}
