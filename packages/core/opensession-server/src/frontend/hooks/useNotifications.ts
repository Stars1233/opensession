import { useSyncExternalStore } from "react";
import {
  getNotificationState,
  subscribeNotifications,
  type NotificationState,
} from "../lib/notifications";

/** Your notification inbox, live (lib/notifications.ts). */
export function useNotifications(): NotificationState {
  return useSyncExternalStore(
    subscribeNotifications,
    getNotificationState,
    getNotificationState,
  );
}
