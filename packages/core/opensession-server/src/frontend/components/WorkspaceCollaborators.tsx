import { useState } from "react";
import {
  addWorkspaceCollaboratorApi,
  removeWorkspaceCollaboratorApi,
} from "../lib/api";
import { errorMessage } from "../lib/error-message";
import { usePeople } from "../lib/people";
import {
  GIT_ACTION_CARET,
  gitActionClass,
  GIT_LABEL,
  GIT_ROW,
} from "../lib/pr-tone-classes";
import {
  INFO_LABEL_CLASS,
  INFO_LIST_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import {
  publishWorkspaceRecord,
  useWorkspaceRecord,
} from "../lib/workspace-records";
import { Menu } from "../ui/menu";
import { IconChevronDown, IconPeople } from "./icons";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser, TEAM } from "./UserPicker";

/**
 * The info panel's Collaborators section: teammates added to this workspace
 * besides its creator. Each one gets the workspace in their own sidebar, and
 * the server notifies them once, when they are first added.
 */
export function WorkspaceCollaborators({
  workspaceId,
  sessionId,
}: {
  workspaceId: string | null;
  /** The open session, where the new collaborator's notification points. */
  sessionId?: string;
}) {
  // The roster arrives async; TEAM below reads it.
  usePeople();
  const workspace = useWorkspaceRecord(workspaceId);
  const [error, setError] = useState<string | null>(null);
  if (!workspace) return null;

  const collaborators = workspace.collaborators || [];
  const names = new Set(collaborators.map((c) => c.name.toLowerCase()));
  const creator = workspace.createdBy.toLowerCase();
  const candidates = TEAM.filter((name) => name.toLowerCase() !== creator);
  if (!candidates.length && !collaborators.length) return null;

  function toggle(name: string) {
    if (!workspace) return;
    const on = names.has(name.toLowerCase());
    const optimistic = on
      ? collaborators.filter((c) => c.name.toLowerCase() !== name.toLowerCase())
      : [
          ...collaborators,
          { name, by: getCurrentUser(), at: new Date().toISOString() },
        ];
    const previous = workspace;
    setError(null);
    publishWorkspaceRecord({ ...workspace, collaborators: optimistic });
    const request = on
      ? removeWorkspaceCollaboratorApi(workspace.id, name)
      : addWorkspaceCollaboratorApi(
          workspace.id,
          name,
          getCurrentUser(),
          sessionId || undefined,
        );
    request.then(publishWorkspaceRecord).catch((cause: unknown) => {
      publishWorkspaceRecord(previous);
      setError(
        errorMessage(
          cause,
          on ? "Failed to remove collaborator" : "Failed to add collaborator",
        ),
      );
    });
  }

  const shown = collaborators.slice(0, 3);
  const label = collaborators.length
    ? collaborators.map((c) => c.name).join(", ")
    : "Only the creator";
  return (
    <div className={INFO_SECTION_CLASS}>
      <div className={INFO_LABEL_CLASS}>Collaborators</div>
      <div className={INFO_LIST_CLASS}>
        <div className={`${GIT_ROW} rounded-md py-2`}>
          {shown.length ? (
            <span className="flex shrink-0 -space-x-1.5">
              {shown.map((c) => (
                <UserAvatar key={c.name} name={c.name} size={20} />
              ))}
            </span>
          ) : (
            <span className="inline-flex size-5 shrink-0 items-center justify-center text-dim">
              <IconPeople size={18} />
            </span>
          )}
          <span
            className={`${GIT_LABEL} ${collaborators.length ? "" : "text-dim"}`}
            title={collaborators
              .map((c) => `${c.name}, added by ${c.by}`)
              .join("\n")}
          >
            {label}
          </span>
          <Menu.Root>
            <Menu.Trigger
              className={gitActionClass("muted", true)}
              aria-label="Collaborators"
            >
              {collaborators.length ? "Change" : "Add"}
              <IconChevronDown size={14} className={GIT_ACTION_CARET} />
            </Menu.Trigger>
            <Menu.Popup align="start" sideOffset={6} className="min-w-[200px]">
              {candidates.map((name) => (
                <Menu.Item
                  key={name}
                  closeOnClick={false}
                  onClick={() => toggle(name)}
                >
                  <UserAvatar name={name} size={22} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <Menu.Check
                    on={names.has(name.toLowerCase())}
                    size={20}
                    className="text-dim"
                  />
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Root>
        </div>
      </div>
      {error && (
        <div className="px-3 text-meta font-medium text-red">{error}</div>
      )}
    </div>
  );
}
