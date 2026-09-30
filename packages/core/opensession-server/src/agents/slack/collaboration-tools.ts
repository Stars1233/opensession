/**
 * Reviewer and collaborator tools for opensession-sessions: the same review
 * request the info panel's Reviewer picker sets, and the same workspace
 * collaborators the Collaborators menu adds. Both go through the shared
 * server modules the HTTP routes use (session-review.ts, collaborators.ts),
 * so an agent's change mirrors onto GitHub and notifies people exactly like
 * a click in the UI.
 *
 * Every tool here changes what other people see or get notified about, so
 * sessions-tools.ts registers them only for trusted (isAdmin) contexts.
 */
import { z } from "zod";
import { audit } from "../../server/audit";
import { addCollaborator, teammateName } from "../../server/collaborators";
import { githubCredentialForRun } from "../../server/github-auth";
import { tool } from "../../server/inprocess-mcp";
import { teamFirstNames } from "../../server/people";
import { findSessionAsync } from "../../server/session-cache";
import {
  acceptSessionReview,
  resolveReviewer,
  reviewerChoices,
  sessionReviewRequest,
  setSessionReviewer,
} from "../../server/session-review";
import type { UnifiedSession } from "../../server/types";
import {
  getWorkspace,
  removeWorkspaceCollaborator,
  type Workspace,
} from "../../server/workspaces";

export interface CollaborationToolContext {
  /** Display name credited as the asker / adder. */
  createdBy: string;
  /** The session using these tools; the default target. */
  currentSessionId?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const sessionIdArg = z
  .string()
  .optional()
  .describe("Session id. Defaults to the current session.");

const workspaceArgs = {
  workspace_id: z
    .string()
    .optional()
    .describe(
      "Workspace id. Defaults to the workspace of session_id, or of the current session.",
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      "Use this session's workspace when workspace_id is omitted. Defaults to the current session.",
    ),
};

type Lookup<T> = { ok: true; value: T } | { ok: false; error: string };

async function sessionFor(
  ctx: CollaborationToolContext,
  sessionId: string | undefined,
): Promise<Lookup<{ id: string; session: UnifiedSession }>> {
  const id = sessionId?.trim() || ctx.currentSessionId;
  if (!id) return { ok: false, error: "Pass session_id." };
  const session = await findSessionAsync(id);
  if (!session) return { ok: false, error: `No session with id \`${id}\`.` };
  return { ok: true, value: { id, session } };
}

async function workspaceFor(
  ctx: CollaborationToolContext,
  args: { workspace_id?: string; session_id?: string },
): Promise<Lookup<Workspace>> {
  let id = args.workspace_id?.trim();
  if (!id) {
    const found = await sessionFor(ctx, args.session_id);
    if (!found.ok) return found;
    id = found.value.session.workspaceId || undefined;
    if (!id)
      return {
        ok: false,
        error: `Session \`${found.value.id}\` is not in a workspace.`,
      };
  }
  const workspace = await getWorkspace(id);
  if (!workspace)
    return { ok: false, error: `No workspace with id \`${id}\`.` };
  return { ok: true, value: workspace };
}

function describeRequest(sessionId: string, session: UnifiedSession): string {
  const request = sessionReviewRequest(session, sessionId);
  if (!request) return `Session \`${sessionId}\` has no reviewer.`;
  const lines = [
    `Reviewer: ${request.to}${request.recipients?.length ? ` (${request.recipients.join(", ")})` : ""}`,
    `Requested by ${request.by} at ${request.at}`,
    request.accepted
      ? `Reviewed by ${request.accepted.by} at ${request.accepted.at}`
      : "Not reviewed yet",
  ];
  return lines.join("\n");
}

function describeCollaborators(workspace: Workspace): string {
  const list = workspace.collaborators || [];
  const lines = [
    `Workspace "${workspace.name}" (\`${workspace.id}\`)`,
    `Creator: ${workspace.createdBy}`,
    list.length
      ? `Collaborators:\n${list.map((c) => `- ${c.name} (added by ${c.by} at ${c.at})`).join("\n")}`
      : "Collaborators: none",
  ];
  return lines.join("\n");
}

function unknownReviewer(ref: string): string {
  return `"${ref}" is not a teammate or review team. Choose one of: ${reviewerChoices().join(", ")}.`;
}

function unknownTeammate(ref: string): string {
  return `"${ref}" is not a teammate. Choose one of: ${teamFirstNames().join(", ")}.`;
}

export function collaborationTools(ctx: CollaborationToolContext): any[] {
  const by = ctx.createdBy.slice(0, 40) || "someone";
  return [
    // -------------------------------------------------------------------
    // Reviewers
    // -------------------------------------------------------------------
    tool(
      "get_session_reviewer",
      "Show who is asked to review a session, who asked, and whether they signed off. Also lists everyone a review can be requested from.",
      { session_id: sessionIdArg },
      async (args: { session_id?: string }) => {
        const found = await sessionFor(ctx, args.session_id);
        if (!found.ok) return text(found.error);
        const { id, session } = found.value;
        return text(
          `${describeRequest(id, session)}\n\nReviewer choices: ${reviewerChoices().join(", ")}`,
        );
      },
    ),
    tool(
      "set_session_reviewer",
      "Ask a teammate or review team to review a session, replacing any current reviewer. It lands in their sidebar's Needs review band and sends them a notification. When the session has a GitHub pull request, the reviewer is also requested there (and a replaced reviewer removed) with the acting person's GitHub connection.",
      {
        session_id: sessionIdArg,
        reviewer: z
          .string()
          .describe(
            "Teammate first name, full name, or GitHub login, or a review team name or 'org/team' spec.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Registered repo id whose pull request to mirror onto, for multi-repo sessions. Defaults to the primary repo.",
          ),
      },
      async (args: {
        session_id?: string;
        reviewer: string;
        repo?: string;
      }) => {
        const reviewer = resolveReviewer(args.reviewer);
        if (!reviewer) return text(unknownReviewer(args.reviewer));
        const found = await sessionFor(ctx, args.session_id);
        if (!found.ok) return text(found.error);
        const { id, session } = found.value;
        const result = await setSessionReviewer({
          session,
          sessionId: id,
          reviewer,
          by,
          repo: args.repo,
          credential: githubCredentialForRun(ctx.createdBy),
        });
        if (!result.ok) return text(`Could not set reviewer: ${result.error}`);
        audit({
          msg: "mcp_session_reviewer_set",
          session_id: id,
          reviewer,
          by,
        });
        return text(describeRequest(id, session));
      },
    ),
    tool(
      "remove_session_reviewer",
      "Clear a session's reviewer and withdraw the request from its GitHub pull request. With no reviewer set here, withdraws the pull request's pending GitHub review requests instead.",
      {
        session_id: sessionIdArg,
        repo: z
          .string()
          .optional()
          .describe(
            "Registered repo id whose pull request to update, for multi-repo sessions. Defaults to the primary repo.",
          ),
      },
      async (args: { session_id?: string; repo?: string }) => {
        const found = await sessionFor(ctx, args.session_id);
        if (!found.ok) return text(found.error);
        const { id, session } = found.value;
        const result = await setSessionReviewer({
          session,
          sessionId: id,
          reviewer: "",
          by,
          repo: args.repo,
          credential: githubCredentialForRun(ctx.createdBy),
        });
        if (!result.ok)
          return text(`Could not remove reviewer: ${result.error}`);
        audit({ msg: "mcp_session_reviewer_removed", session_id: id, by });
        return text(`Removed the reviewer from session \`${id}\`.`);
      },
    ),
    tool(
      "accept_session_review",
      "Mark a session's review request as reviewed (the reviewer signs off), or reopen it with accept false. Keeps the reviewer and does not touch GitHub. Accepting notifies whoever asked.",
      {
        session_id: sessionIdArg,
        accept: z
          .boolean()
          .optional()
          .describe("true (default) marks it reviewed; false reopens it."),
      },
      async (args: { session_id?: string; accept?: boolean }) => {
        const found = await sessionFor(ctx, args.session_id);
        if (!found.ok) return text(found.error);
        const { id, session } = found.value;
        const accept = args.accept ?? true;
        const result = await acceptSessionReview(session, id, accept, by);
        if (!result.ok) return text(result.error);
        audit({
          msg: "mcp_session_review_accepted",
          session_id: id,
          accept,
          by,
        });
        return text(describeRequest(id, session));
      },
    ),
    // -------------------------------------------------------------------
    // Collaborators
    // -------------------------------------------------------------------
    tool(
      "list_collaborators",
      "List a workspace's creator and collaborators. Collaborators see the workspace in their own sidebar like its creator does.",
      workspaceArgs,
      async (args: { workspace_id?: string; session_id?: string }) => {
        const found = await workspaceFor(ctx, args);
        if (!found.ok) return text(found.error);
        return text(describeCollaborators(found.value));
      },
    ),
    tool(
      "add_collaborator",
      "Add a teammate to a workspace so it shows in their sidebar. The first add notifies them; adding someone already listed changes nothing.",
      {
        name: z
          .string()
          .describe("Teammate first name, full name, or GitHub login."),
        ...workspaceArgs,
      },
      async (args: {
        name: string;
        workspace_id?: string;
        session_id?: string;
      }) => {
        const name = teammateName(args.name);
        if (!name) return text(unknownTeammate(args.name));
        const found = await workspaceFor(ctx, args);
        if (!found.ok) return text(found.error);
        // The mention badge points at the session the add came from.
        const sessionId =
          args.session_id?.trim() || ctx.currentSessionId || null;
        const result = await addCollaborator(
          found.value.id,
          name,
          by,
          sessionId,
        );
        if (!result) return text(`No workspace with id \`${found.value.id}\`.`);
        audit({
          msg: "mcp_collaborator_added",
          workspace_id: found.value.id,
          name,
          by,
          added: result.added,
        });
        return text(
          `${result.added ? `Added ${name}.` : `${name} was already a collaborator.`}\n\n${describeCollaborators(result.workspace)}`,
        );
      },
    ),
    tool(
      "remove_collaborator",
      "Remove a teammate from a workspace's collaborators. Removing someone who is not listed changes nothing. The creator cannot be removed.",
      {
        name: z
          .string()
          .describe("Teammate first name, full name, or GitHub login."),
        ...workspaceArgs,
      },
      async (args: {
        name: string;
        workspace_id?: string;
        session_id?: string;
      }) => {
        const found = await workspaceFor(ctx, args);
        if (!found.ok) return text(found.error);
        const name = teammateName(args.name) || args.name.trim();
        const listed = (found.value.collaborators || []).some(
          (c) => c.name.toLowerCase() === name.toLowerCase(),
        );
        if (!listed)
          return text(
            `${name} is not a collaborator.\n\n${describeCollaborators(found.value)}`,
          );
        const workspace = await removeWorkspaceCollaborator(
          found.value.id,
          name,
        );
        if (!workspace)
          return text(`No workspace with id \`${found.value.id}\`.`);
        audit({
          msg: "mcp_collaborator_removed",
          workspace_id: workspace.id,
          name,
          by,
        });
        return text(`Removed ${name}.\n\n${describeCollaborators(workspace)}`);
      },
    ),
  ];
}
