import { useNotifications } from "../../hooks/useNotifications";
import { INBOX_LIST } from "../../lib/inbox-classes";
import { filterThreads, type InboxFilter } from "../../lib/notifications";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { EmptyState, ListSkeleton } from "../../ui/state";
import { IconInbox } from "../icons";
import { NotificationRow } from "./NotificationRow";

const EMPTY: Record<InboxFilter, { title: string; body: string }> = {
  unread: {
    title: "You're all caught up",
    body: "Review requests and workspace invites show up here.",
  },
  all: {
    title: "No notifications yet",
    body: "When someone asks for your review or adds you to a workspace, it shows up here.",
  },
  done: {
    title: "Nothing marked done",
    body: "Rows you mark done move here.",
  },
};

export function InboxFilterControl({
  value,
  onChange,
  unread,
}: {
  value: InboxFilter;
  onChange: (value: InboxFilter) => void;
  unread: number;
}) {
  return (
    <Segmented
      label="Show"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next === "all" || next === "unread" || next === "done")
          onChange(next);
      }}
    >
      <SegmentedOption value="unread">
        Unread{unread > 0 ? ` ${unread}` : ""}
      </SegmentedOption>
      <SegmentedOption value="all">All</SegmentedOption>
      <SegmentedOption value="done">Done</SegmentedOption>
    </Segmented>
  );
}

export function NotificationList({
  filter,
  onOpen,
}: {
  filter: InboxFilter;
  onOpen?: () => void;
}) {
  const { threads, loaded } = useNotifications();
  if (!loaded)
    return (
      <ListSkeleton rows={4} variant="bare" label="Loading notifications" />
    );
  const rows = filterThreads(threads, filter);
  if (!rows.length)
    return (
      <EmptyState icon={<IconInbox size={22} />} title={EMPTY[filter].title}>
        {EMPTY[filter].body}
      </EmptyState>
    );
  return (
    <ul className={INBOX_LIST} aria-label="Notifications">
      {rows.map((thread) => (
        <NotificationRow key={thread.id} thread={thread} onOpen={onOpen} />
      ))}
    </ul>
  );
}
