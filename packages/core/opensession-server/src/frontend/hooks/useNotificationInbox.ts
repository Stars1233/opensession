import { useEffect, useEffectEvent } from "react";
import { notificationThreadSchema } from "../lib/api/notifications";
import { parseRoute, type Route } from "../lib/app-route";
import {
  receiveNotification,
  receiveNotificationsChanged,
  refreshNotifications,
  startNotifications,
} from "../lib/notifications";
import type { WSServerMessage } from "../lib/types";

/**
 * Keep this device's notification inbox (lib/notifications.ts) live: start it,
 * route its rows through the app router, apply the server's frames, and catch
 * up after a reconnect. A reconnect only refreshes the list. Banners come
 * from a live `notification` frame alone, which is what keeps a reload or an
 * app restart from replaying them.
 */
export function useNotificationInbox({
  navigate,
  connected,
  addHandler,
}: {
  navigate: (route: Route) => void;
  connected: boolean;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}): void {
  const open = useEffectEvent((url: string) => {
    try {
      navigate(parseRoute(new URL(url, window.location.origin).pathname));
    } catch {
      // A malformed URL is not worth losing the current page over.
    }
  });
  useEffect(() => startNotifications((url) => open(url)), []);

  useEffect(() => {
    if (connected) refreshNotifications();
  }, [connected]);

  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "notification") {
          // A kind this build does not know yet still reaches the list on
          // the next refresh; it just raises no banner here.
          const thread = notificationThreadSchema.safeParse(msg.notification);
          if (thread.success)
            receiveNotification(msg.user, thread.data, msg.alert);
        } else if (msg.type === "notifications_changed") {
          receiveNotificationsChanged(msg.user);
        }
      }),
    [addHandler],
  );
}
