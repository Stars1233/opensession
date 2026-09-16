/**
 * The single source of truth for the GitHub App's permissions.
 *
 * One definition renders three ways — the create-app URL (what GitHub grants
 * the App), the read installation token, and the write installation token — so
 * they can never drift apart. Drift is exactly what left real Apps missing
 * `checks` and `issues`: the create builders under-requested, the mints asked
 * for scopes the App was never granted, and every installation token 422'd and
 * failed open through unrelated host credentials.
 *
 * A mint is all-or-nothing: it succeeds only if every requested scope is a
 * subset of what the installation holds. So each mint set below is a strict
 * subset of the grant set, and the grant set is what the create URL requests.
 *
 * The installation is expected to hold contents:write: agent runs push their
 * branches with a repository-scoped installation token, and what that token
 * may push is a ruleset decision on GitHub (docs/github-authority.md), not a
 * permission cap. An installation an operator has capped at contents:read is
 * handled at mint time by falling back to the read set for contents, so
 * reviews and comments keep working while pushes fail loudly.
 *
 * administration:write is in the grant for exactly one call: creating a
 * private repository in an organization from Settings → Repositories or the
 * New session palette. Only the create mint below asks for it. The read,
 * write and code sets never do, so those installation tokens cannot edit
 * repository settings or rulesets. Connected-user tokens still inherit the
 * App grant intersected with the person's access. An installation that has not yet
 * approved the added permission keeps every other mint working: creation is
 * the one thing that fails, with a message naming the approval.
 */

/** The full set the App is granted at creation — the create-URL permission
 *  params, and the superset of every mint. */
export const GITHUB_APP_GRANT_PERMISSIONS: Record<string, string> = {
  actions: "read", // workflow runs/logs for trusted autofix diagnosis
  checks: "read", // CI check runs
  statuses: "read", // commit statuses, the other half of the status rollup
  contents: "write", // clone; pushes only while git transport rides App tokens
  administration: "write", // create private repositories; create mint only
  pull_requests: "write", // reviews, comments, open/merge
  issues: "write", // issue and PR comments
  members: "read", // team roster / attribution
  deployments: "read", // Vercel preview deployment + status polling
  metadata: "read", // required baseline
};

/** Read installation token (pr-info's statusCheckRollup) — the read view of the
 *  grant. Contents/pull_requests/issues at read, plus actions/checks/statuses,
 *  members, deployments, and metadata as granted.
 *
 *  `actions: read` is NOT optional despite the rollup being "just checks":
 *  gh's `pr view --json statusCheckRollup` selects `checkSuite.workflowRun` on
 *  every check run, and that field is gated on Actions. Without it GitHub fails
 *  the whole GraphQL response with "Resource not accessible by integration
 *  (…checkSuite.workflowRun)" — no data at all, not a partial result — which
 *  surfaced as "The GitHub App is missing a permission for this API" on every
 *  PR panel, review and auto-fix run. Verified live: same installation, same
 *  query, read mint → hard failure, read+actions mint → full payload. */
export const GITHUB_APP_READ_PERMISSIONS: Record<string, string> = {
  actions: "read",
  checks: "read",
  statuses: "read",
  pull_requests: "read",
  contents: "read",
  issues: "read",
  members: "read",
  deployments: "read",
  metadata: "read",
};

/** Write installation token (the PR agent) — exactly what writes need. No
 *  read-only scopes: their absence must not 422 a token that never touches
 *  them. */
export const GITHUB_APP_WRITE_PERMISSIONS: Record<string, string> = {
  pull_requests: "write",
  issues: "write",
  contents: "write",
  metadata: "read",
};

/** Repository-scoped token projected only to trusted GitHub code workflows.
 * It can push/reply and inspect the failing checks and workflow logs it must
 * diagnose, but remains bound to the one owner-verified repository. */
export const GITHUB_APP_CODE_PERMISSIONS: Record<string, string> = {
  ...GITHUB_APP_WRITE_PERMISSIONS,
  actions: "read",
  checks: "read",
  statuses: "read",
};

/** The mint behind "New repository" on GitHub: create one private repository
 *  in an organization, then confirm its first commit exists before cloning.
 *  Minted for that request and dropped; never cached, never handed to a run.
 *  This is the only set that carries `administration`. */
export const GITHUB_APP_REPO_CREATE_PERMISSIONS: Record<string, string> = {
  administration: "write",
  contents: "read",
  metadata: "read",
};

/** The same set with `contents` narrowed to read: the fallback a mint
 * retries with when the installation turns out not to hold contents:write.
 * Unchanged (same object) when the set never asked for write. */
export function withReadOnlyContents(
  set: Record<string, string>,
): Record<string, string> {
  if (set.contents !== "write") return set;
  return { ...set, contents: "read" };
}
