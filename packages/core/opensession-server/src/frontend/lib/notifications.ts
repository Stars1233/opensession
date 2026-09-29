/**
 * Your notification inbox, on this device. The server owns it
 * (src/server/notifications.ts): one row per session, pull request, workspace
 * or reminder, with read and done state shared by every device you use.
 *
 * Banners come only from a `notification` socket frame, which the server
 * sends once, when an event is first recorded. Nothing here compares session
 * lists, so reloading the page or restarting the desktop app cannot replay a
 * notification: a reconnect refreshes the list silently.
 *
 * Same in-memory shape as mentions.ts: synchronous reads, hydrated on start,
 * on user switch and on reconnect, updated live from the socket.
 */

import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_ALERTS,
  fetchNotifications,
  markNotificationsApi,
  saveNotificationAlertsApi,
  type NotificationAlerts,
  type NotificationThread,
} from "./api/notifications";
import { getCurrentUser } from "../components/UserPicker";
import { whenCurrentUserReady } from "./auth-ready";
import {
  appFocused,
  closeAlert,
  legacyEventSettings,
  showAlert,
} from "./notify";
import { os1Shell } from "./os1-shell";
import { getPushState } from "./push";

export type { NotificationThread, NotificationAlerts };

const USER_CHANGE_EVENT = "opensession-user-changed";
const MIGRATED_KEY = "opensession-notif-alerts-migrated";

export interface NotificationState {
  threads: NotificationThread[];
  alerts: NotificationAlerts;
  loaded: boolean;
}

let state: NotificationState = {
  threads: [],
  alerts: DEFAULT_NOTIFICATION_ALERTS,
  loaded: false,
};
let loadedFor: string | null = null;
const listeners = new Set<() => void>();
let openUrl: (url: string) => void = (url) => {
  window.location.assign(url);
};
// Whether this device receives Web Push. When it does, the service worker
// shows the banner, and the page must not show a second one.
let pushOn = false;

function set(next: NotificationState): void {
  state = next;
  syncBadge();
  for (const listener of listeners) listener();
}

export function getNotificationState(): NotificationState {
  return state;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type InboxFilter = "all" | "unread" | "done";

/** The rows a filter shows, newest first. Done rows only show under Done. */
export function filterThreads(
  threads: readonly NotificationThread[],
  filter: InboxFilter,
): NotificationThread[] {
  return threads
    .filter((thread) =>
      filter === "done"
        ? thread.done
        : !thread.done && (filter === "all" || thread.unread),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function unreadNotificationCount(
  threads: readonly NotificationThread[] = state.threads,
): number {
  return threads.filter((thread) => thread.unread && !thread.done).length;
}

// The Dock (desktop shell) and home-screen icon (installed PWA) show what
// is unread in the inbox, the same count as the bell.
function syncBadge(): void {
  if (!state.loaded) return;
  const count = unreadNotificationCount();
  try {
    const shell = os1Shell();
    if (shell?.setBadge instanceof Function) {
      shell.setBadge(count);
      return;
    }
  } catch {}
  try {
    if (count > 0) void navigator.setAppBadge?.(count).catch(() => {});
    else void navigator.clearAppBadge?.().catch(() => {});
  } catch {}
}

function sameUser(user: string): boolean {
  return user.trim().toLowerCase() === getCurrentUser().trim().toLowerCase();
}

async function load(user: string): Promise<void> {
  loadedFor = user;
  try {
    const inbox = await fetchNotifications(user);
    if (loadedFor !== user) return;
    set({ ...inbox, loaded: true });
    void migrateLegacyAlerts(inbox.alerts);
  } catch {
    // Keep what we had. The next reconnect or change frame retries.
  }
}

// The event switches used to be per device. Carry a non-default choice to
// the server once, so nobody silently gets alerts they had turned off.
async function migrateLegacyAlerts(current: NotificationAlerts): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    localStorage.setItem(MIGRATED_KEY, "1");
    const legacy = legacyEventSettings();
    if (!legacy) return;
    const patch: Partial<NotificationAlerts> = {};
    if (
      legacy.needsInput !== undefined &&
      legacy.needsInput !== current.needsInput
    )
      patch.needsInput = legacy.needsInput;
    if (Object.keys(patch).length) await setNotificationAlerts(patch);
  } catch {}
}

let started = false;
/**
 * Hydrate the inbox and keep it in step with the signed-in person. `open`
 * routes a notification's in-app URL through the app router. Idempotent.
 */
export function startNotifications(open: (url: string) => void): void {
  openUrl = open;
  if (started) return;
  started = true;
  whenCurrentUserReady((user) => void load(user));
  window.addEventListener(USER_CHANGE_EVENT, () => void load(getCurrentUser()));
  void getPushState().then((push) => {
    pushOn = push === "on";
  });
  // A tapped push names its row (sw.js). Routing is useAppRoute's job; the
  // read mark is this module's.
  try {
    navigator.serviceWorker?.addEventListener("message", (event) => {
      const tap = pushTapSchema.safeParse(event.data);
      if (tap.success) markNotificationRead(tap.data.id);
    });
  } catch {}
}

const pushTapSchema = z.object({
  type: z.literal("os1-navigate"),
  id: z.string(),
});

/** Refresh after a reconnect or a change on another device. Never alerts. */
export function refreshNotifications(): void {
  if (!started) return;
  void load(getCurrentUser());
}

/** The server announced that your inbox changed somewhere else. */
export function receiveNotificationsChanged(user: string): void {
  if (sameUser(user)) refreshNotifications();
}

/** A session you are looking at right now, if any: news about it is read. */
let viewing: string | null = null;

/** A new notification was recorded for `user`. */
export function receiveNotification(
  user: string,
  thread: NotificationThread,
  alert: boolean,
): void {
  if (!sameUser(user)) return;
  const seenNow =
    thread.subject.type === "session" &&
    thread.subject.id === viewing &&
    appFocused();
  set({
    ...state,
    threads: [thread, ...state.threads.filter((t) => t.id !== thread.id)],
  });
  if (seenNow) {
    // Through the normal mark, so the server hears it too: the row is read
    // on every device, not just this one.
    markNotifications([thread.id], { unread: false });
    return;
  }
  if (!alert || pushOn) return;
  showAlert({
    title: thread.reason,
    body: [thread.subject.title, thread.body].filter(Boolean).join(": "),
    tag: alertTag(thread.id),
    onClick: () => openNotification(thread),
  });
}

function alertTag(id: string): string {
  // Matches the server's push tag, so a pushed banner and a page banner for
  // the same row replace each other rather than stack.
  return `os-notification-${id}`;
}

/** Change read or done state, optimistically, and tell the server. */
export function markNotifications(
  ids: string[],
  mark: { unread?: boolean; done?: boolean },
): void {
  const wanted = new Set(ids);
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (!wanted.has(thread.id)) return thread;
    const next = { ...thread };
    if (mark.unread !== undefined) next.unread = mark.unread;
    if (mark.done !== undefined) {
      next.done = mark.done;
      if (mark.done) next.unread = false;
    }
    if (next.unread !== thread.unread || next.done !== thread.done)
      changed = true;
    return next;
  });
  if (!changed) return;
  set({ ...state, threads });
  if (mark.unread === false || mark.done === true)
    for (const id of ids) closeAlert(alertTag(id));
  void markNotificationsApi(getCurrentUser(), { ids, ...mark }).catch(() =>
    refreshNotifications(),
  );
}

export function markAllNotificationsRead(): void {
  const ids = state.threads
    .filter((thread) => thread.unread && !thread.done)
    .map((thread) => thread.id);
  if (!ids.length) return;
  set({
    ...state,
    threads: state.threads.map((thread) =>
      thread.unread ? { ...thread, unread: false } : thread,
    ),
  });
  for (const id of ids) closeAlert(alertTag(id));
  void markNotificationsApi(getCurrentUser(), {
    all: true,
    unread: false,
  }).catch(() => refreshNotifications());
}

/** Open a row: go where it points and mark it read. */
export function openNotification(thread: NotificationThread): void {
  if (thread.unread) markNotifications([thread.id], { unread: false });
  openUrl(thread.url);
}

/** Route an in-app path through the app router (the Inbox page, Settings). */
export function openInAppUrl(url: string): void {
  openUrl(url);
}

/** A notification tap routed by the service worker. */
export function markNotificationRead(id: string): void {
  const thread = state.threads.find((t) => t.id === id);
  if (thread?.unread) markNotifications([id], { unread: false });
}

/**
 * Track the session on screen. While the window is focused its inbox row is
 * read, including news that arrives while you watch. A background window
 * leaves it unread until you come back to it.
 */
export function watchSessionNotifications(sessionId: string): () => void {
  viewing = sessionId;
  const id = `session:${sessionId}`;
  const check = () => {
    if (!appFocused()) return;
    const thread = state.threads.find((t) => t.id === id);
    if (thread?.unread) markNotifications([id], { unread: false });
  };
  check();
  const unsubscribe = subscribeNotifications(check);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  return () => {
    if (viewing === sessionId) viewing = null;
    unsubscribe();
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
  };
}

export async function setNotificationAlerts(
  patch: Partial<NotificationAlerts>,
): Promise<void> {
  const previous = state.alerts;
  set({ ...state, alerts: { ...state.alerts, ...patch } });
  try {
    const alerts = await saveNotificationAlertsApi(getCurrentUser(), patch);
    set({ ...state, alerts });
  } catch (error) {
    set({ ...state, alerts: previous });
    throw error;
  }
}

/** Settings flipped push on or off for this device. */
export function setPushActive(on: boolean): void {
  pushOn = on;
}
