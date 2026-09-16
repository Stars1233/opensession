import { useSyncExternalStore } from "react";
import {
  onSessionTitlesChanged,
  sessionAgentName,
  sessionAgentTitle,
} from "../lib/markdown";

/** Metadata can arrive after a message, including an archived worker's parent. */
export function useAgentName(sessionId?: string): string {
  const snapshot = () =>
    sessionId ? sessionAgentName(sessionId) : "Unknown session";
  return useSyncExternalStore(onSessionTitlesChanged, snapshot, snapshot);
}

export function useAgentSessionTitle(sessionId?: string): string {
  const snapshot = () => (sessionId ? sessionAgentTitle(sessionId) : "");
  return useSyncExternalStore(onSessionTitlesChanged, snapshot, snapshot);
}
