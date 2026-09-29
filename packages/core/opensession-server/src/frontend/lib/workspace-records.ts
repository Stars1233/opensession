/**
 * The app's current workspace records by id, for panels that sit several
 * component layers below the list owner (useWorkspaces). The list stays the
 * source; this only mirrors it, plus a write-through for a record a mutation
 * just returned so the panel does not wait for the list's refresh.
 */

import { useSyncExternalStore } from "react";
import type { Workspace } from "./types";

let records = new Map<string, Workspace>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function publishWorkspaceRecords(list: readonly Workspace[]): void {
  records = new Map(list.map((workspace) => [workspace.id, workspace]));
  emit();
}

export function publishWorkspaceRecord(workspace: Workspace): void {
  records = new Map(records).set(workspace.id, workspace);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkspaceRecord(id: string | null): Workspace | null {
  return useSyncExternalStore(subscribe, () =>
    id ? (records.get(id) ?? null) : null,
  );
}
