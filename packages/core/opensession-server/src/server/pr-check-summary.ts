/**
 * CI check counts for the bulk PR cache, without the check list.
 *
 * The bulk `gh pr list` refresh cannot carry `statusCheckRollup`: that field
 * pages every check context and cost ~111 GraphQL points per sweep. GitHub's
 * rollup connection also answers per-state counts, though, and asking for
 * those alone costs a couple of points per hundred PRs. The sidebar only needs
 * counts to tell "checks still running" apart from "ready to merge".
 *
 * Counts follow the detail pane's buckets (pr-status-derive `checkClass`), so
 * a row and its open PR tab never disagree about what is failing or pending.
 */

export interface PrChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface StateCount {
  state?: string | null;
  count?: number | null;
}

export interface RollupContextCounts {
  totalCount?: number | null;
  checkRunCountsByState?: StateCount[] | null;
  statusContextCountsByState?: StateCount[] | null;
}

export const EMPTY_CHECKS: PrChecksSummary = {
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
};

// CheckRunState merges a run's status and conclusion. Everything else
// (skipped, neutral, cancelled, stale, action required) is neutral, as in the
// detail pane.
const RUN_PASSED = new Set(["SUCCESS"]);
const RUN_FAILED = new Set(["FAILURE", "TIMED_OUT"]);
const RUN_PENDING = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"]);
// StatusState, for commit statuses such as preview deploys.
const STATUS_PASSED = new Set(["SUCCESS"]);
const STATUS_FAILED = new Set(["FAILURE", "ERROR"]);
const STATUS_PENDING = new Set(["PENDING", "EXPECTED"]);

export function summarizeRollupCounts(
  contexts: RollupContextCounts | null | undefined,
): PrChecksSummary {
  if (!contexts) return { ...EMPTY_CHECKS };
  const out = { ...EMPTY_CHECKS, total: contexts.totalCount || 0 };
  const add = (
    rows: StateCount[] | null | undefined,
    passed: Set<string>,
    failed: Set<string>,
    pending: Set<string>,
  ) => {
    for (const row of rows || []) {
      const state = (row.state || "").toUpperCase();
      const count = row.count || 0;
      if (passed.has(state)) out.passed += count;
      else if (failed.has(state)) out.failed += count;
      else if (pending.has(state)) out.pending += count;
    }
  };
  add(contexts.checkRunCountsByState, RUN_PASSED, RUN_FAILED, RUN_PENDING);
  add(
    contexts.statusContextCountsByState,
    STATUS_PASSED,
    STATUS_FAILED,
    STATUS_PENDING,
  );
  return out;
}

/** CI usually registers its first checks within a minute or two of a push. */
export const CHECKS_REGISTER_WINDOW_MS = 15 * 60_000;

/**
 * Whether an open PR's cached counts need asking GitHub again. Settled counts
 * for the current head are final unless a CI webhook says otherwise, so a
 * refresh only spends quota on PRs whose CI is running, unknown, or new.
 */
export function checksNeedRefresh(
  pr: {
    state: string;
    headRefOid?: string;
    checksHead?: string;
    checks: PrChecksSummary;
    updatedAt: string;
  },
  opts: { stale: boolean; now: number },
): boolean {
  if (pr.state !== "OPEN") return false;
  if (opts.stale) return true;
  if (!pr.checksHead || pr.checksHead !== pr.headRefOid) return true;
  if (pr.checks.pending > 0) return true;
  // No checks yet: CI may not have registered. Stop asking once the PR has
  // been quiet long enough that it plainly has no CI.
  if (pr.checks.total === 0)
    return (
      opts.now - (Date.parse(pr.updatedAt) || 0) < CHECKS_REGISTER_WINDOW_MS
    );
  return false;
}
