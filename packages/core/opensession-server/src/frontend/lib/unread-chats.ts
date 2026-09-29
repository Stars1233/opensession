import { sessionRepo } from "./sidebar-filter";
import { isUnread } from "./reads";
import type { WsRow } from "./sidebar-types";

export interface UnreadChat {
  id: string;
  title: string;
  workspace: string;
  repo: string;
}

/** Work from the sidebar inventory, not its mounted rows: collapsed groups and
 * sibling tabs still count, but personal hides, filters and snoozes still apply.
 * The sidebar also shows other people's work (review requests, teammates'
 * sessions in a shared workspace, a person filter), so only sessions `isMine`
 * accepts become destinations. */
export function unreadChatsInOrder(
  rows: readonly Pick<WsRow, "key" | "sessions" | "workspace">[],
  selectedId: string | null,
  reads: Record<string, string>,
  snoozedKeys: ReadonlySet<string>,
  isMine: (session: WsRow["sessions"][number]) => boolean,
): UnreadChat[] {
  const selected = rows.findIndex((row) =>
    row.sessions.some((session) => session.id === selectedId),
  );
  const ordered =
    selected < 0 ? rows : [...rows.slice(selected), ...rows.slice(0, selected)];
  const seen = new Set<string>();
  return ordered.flatMap((row) => {
    if (snoozedKeys.has(row.key)) return [];
    return row.sessions
      .filter(
        (session) =>
          session.id !== selectedId &&
          !session.archived &&
          !session.desk &&
          !session.parentSessionId &&
          isMine(session) &&
          isUnread(session, reads),
      )
      .sort(
        (a, b) =>
          b.lastActivity.localeCompare(a.lastActivity) ||
          a.id.localeCompare(b.id),
      )
      .flatMap((session) => {
        if (seen.has(session.id)) return [];
        seen.add(session.id);
        return [
          {
            id: session.id,
            repo: sessionRepo(session),
            title: session.title || "Untitled session",
            workspace: row.workspace?.name || session.workspaceName || "",
          },
        ];
      });
  });
}

/** Hold the order and labels under the pointer, but never offer a destination
 * that has since been read, archived, hidden, or started running. */
export function availableHeldChats(
  held: readonly UnreadChat[] | null,
  live: readonly UnreadChat[],
): readonly UnreadChat[] {
  if (!held) return live;
  const available = new Set(live.map((chat) => chat.id));
  return held.filter((chat) => available.has(chat.id));
}
