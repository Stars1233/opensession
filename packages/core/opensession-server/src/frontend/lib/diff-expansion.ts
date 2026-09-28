import { canAutoExpandDiffFile } from "./review-diff";

/**
 * Which files of a multi-file diff are open, keyed by path so the state
 * survives a refreshed patch, a reordered file list, and a remount.
 *
 * `seen` records every path that already received its default, so a file the
 * reader collapsed stays collapsed when the patch is polled again, and only a
 * file that newly appears gets the auto-expand treatment. `viewedApplied`
 * does the same for the one-time "collapse files already marked viewed" pass.
 */
export interface DiffExpansion {
  open: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  viewedApplied: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
}

export const EMPTY_DIFF_EXPANSION: DiffExpansion = {
  open: new Set(),
  seen: new Set(),
  viewedApplied: new Set(),
  collapsedGroups: new Set(),
};

export interface DiffExpansionFile {
  name: string;
  lines: number;
}

/** Give every not-yet-seen file its default open state. */
export function applyDiffDefaults(
  state: DiffExpansion,
  files: readonly DiffExpansionFile[],
  defaultExpandedFiles: number,
): DiffExpansion {
  let open: Set<string> | null = null;
  let seen: Set<string> | null = null;
  files.forEach((file, index) => {
    if (state.seen.has(file.name)) return;
    seen ??= new Set(state.seen);
    seen.add(file.name);
    if (
      index < defaultExpandedFiles &&
      canAutoExpandDiffFile(file.name, file.lines)
    ) {
      open ??= new Set(state.open);
      open.add(file.name);
    }
  });
  if (!seen) return state;
  return { ...state, seen, open: open ?? state.open };
}

/** Collapse files already marked viewed, once per file, so a reader who
 *  re-opens a viewed file is never fought. */
export function applyViewedCollapse(
  state: DiffExpansion,
  files: readonly DiffExpansionFile[],
  viewed: ReadonlySet<string>,
): DiffExpansion {
  let open: Set<string> | null = null;
  let applied: Set<string> | null = null;
  for (const file of files) {
    if (state.viewedApplied.has(file.name)) continue;
    applied ??= new Set(state.viewedApplied);
    applied.add(file.name);
    if (viewed.has(file.name) && state.open.has(file.name)) {
      open ??= new Set(state.open);
      open.delete(file.name);
    }
  }
  if (!applied) return state;
  return { ...state, viewedApplied: applied, open: open ?? state.open };
}

export function setDiffFileOpen(
  state: DiffExpansion,
  name: string,
  open: boolean,
): DiffExpansion {
  if (state.open.has(name) === open) return state;
  const next = new Set(state.open);
  if (open) next.add(name);
  else next.delete(name);
  return { ...state, open: next };
}

/* Remember expansion per surface across remounts (switching sidebar pages,
   reopening the panel). Bounded so a long-lived tab does not accumulate every
   session it has ever shown. */
const MAX_REMEMBERED = 64;
const remembered = new Map<string, DiffExpansion>();

export function rememberedDiffExpansion(key: string | undefined) {
  return (key && remembered.get(key)) || EMPTY_DIFF_EXPANSION;
}

export function rememberDiffExpansion(
  key: string | undefined,
  state: DiffExpansion,
) {
  if (!key) return;
  remembered.delete(key);
  remembered.set(key, state);
  if (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
}
