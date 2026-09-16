/**
 * Workspace checkpoints for Sandbox sessions.
 *
 * A Sandbox's disk is the only copy of the session's uncommitted work, and a
 * provider can lose, expire, or replace that disk. After every clean turn the
 * session pushes a checkpoint to origin: one synthetic commit whose parent is
 * the branch tip and whose tree is the working tree (tracked changes and
 * untracked files that are not ignored), reachable from
 * `refs/opensession/checkpoints/<session id>`. It is a hidden ref: GitHub
 * shows it nowhere, `git fetch` never pulls it, and it costs no host storage.
 *
 * Restoring the checkpoint anywhere (a rebuilt Sandbox, another provider, a
 * worktree on this machine) is `reset --hard <commit>` followed by
 * `reset --mixed <commit>^`: the branch lands on the same tip with the same
 * uncommitted changes. Every restore is that uniform because the checkpoint
 * commit exists even when the tree was clean.
 *
 * What never enters a checkpoint: ignored files, the repository's private seed
 * files (`.agents/environment.json`), and `.ports.conf`, which describes
 * processes on the machine that wrote it. The GitHub App credential used for
 * the push lives only in the push command's environment; the origin remote
 * stays credential-free.
 *
 * Every checkpoint of a session runs on that session's lifecycle lane
 * (lifecycle-lane.ts): one at a time, in request order, and a turn does not
 * start while one is in flight. Two captures can therefore never race each
 * other's force-push, and the recorded commit is always the one the hidden
 * ref points at. A checkpoint is only ever restored onto the branch it was
 * taken from; the record carries that branch and every restore checks it.
 */

import { $ } from "bun";
import { githubServiceCredentialEnv } from "../github-app";
import { findSessionAsync, touchNativeSessionStrict } from "../session-cache";
import { withSessionLifecycleLane } from "./lifecycle-lane";
import type { SandboxCheckpointRecord, UnifiedSession } from "../types";
import {
  getRepo,
  isSharedCheckoutDir,
  withClaimedBranchWorktree,
  type Repo,
} from "../worktree";
import { existsSync } from "node:fs";
import {
  checkpointRestoreScript,
  loadRemoteWorkspaceSeedFiles,
  shellQuoteWord,
} from "./adapters/bootstrap";
import { isRemoteSandboxProvider } from "./config";
import type { Sandbox } from "./provider";

const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const OPENSESSION_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Open Session",
  GIT_AUTHOR_EMAIL: "opensession@localhost",
  GIT_COMMITTER_NAME: "Open Session",
  GIT_COMMITTER_EMAIL: "opensession@localhost",
};

export function checkpointRef(sessionId: string): string {
  return `refs/opensession/checkpoints/${sessionId}`;
}

/**
 * The session's recorded checkpoint when it can be restored for the session
 * as it stands now, that is, when it was taken on the session's current
 * branch. A session can switch branches after a checkpoint (a failed turn
 * takes no new one); restoring the old record then would move the new branch
 * onto an unrelated tip and tree, so such a record is not restorable.
 */
export function restorableCheckpoint(
  session: Pick<UnifiedSession, "branch" | "sandboxCheckpoint">,
): SandboxCheckpointRecord | undefined {
  const checkpoint = session.sandboxCheckpoint;
  return checkpoint && checkpoint.branch === session.branch
    ? checkpoint
    : undefined;
}

/** Only a GitHub-hosted repository can hold a checkpoint: the push uses the
 * workspace's GitHub App credential and a hidden ref on that origin. */
export function checkpointCapable(
  repo: Pick<Repo, "host" | "ghRepo">,
): boolean {
  return repo.host !== "codestorage" && Boolean(repo.ghRepo);
}

/** Git environment for one push or fetch of the hidden ref from inside a
 * Sandbox or a host worktree. The token rides in the environment and is
 * answered by an inline helper, never written to argv, a remote URL, or the
 * repository's configuration. Null when the workspace has no credential. */
async function checkpointGitEnv(
  repo: Repo,
): Promise<Record<string, string> | null> {
  const token = (await githubServiceCredentialEnv(repo.ghRepo)).GH_TOKEN;
  if (!token) return null;
  return {
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1:
      '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
    ...OPENSESSION_GIT_IDENTITY,
  };
}

/** Paths a checkpoint must leave out, repo-relative. */
function excludedPaths(repo: Repo): string[] {
  const seeded = loadRemoteWorkspaceSeedFiles(repo).map((file) => file.path);
  return [".ports.conf", ...seeded];
}

/**
 * The script that builds and pushes the checkpoint. Reads its inputs from the
 * environment so nothing session-specific is interpolated into shell text
 * except the excluded paths, which are quoted. Prints one line:
 * `unchanged <head> <tree>` when the last checkpoint already holds this exact
 * state, else `pushed <commit> <head> <tree>`.
 */
export function checkpointScript(excluded: string[]): string {
  const rm = excluded.length
    ? `git rm -r --cached -q --ignore-unmatch -- ${excluded.map(shellQuoteWord).join(" ")} >/dev/null 2>&1 || true\n`
    : "";
  return [
    "set -eu",
    'cd "$OS_CWD"',
    "head=$(git rev-parse --verify HEAD^{commit})",
    "idx=$(mktemp)",
    'export GIT_INDEX_FILE="$idx"',
    'git read-tree "$head"',
    "git add -A -- .",
    rm.trimEnd(),
    "tree=$(git write-tree)",
    "unset GIT_INDEX_FILE",
    'rm -f "$idx"',
    'if [ "$head" = "${OS_LAST_HEAD:-}" ] && [ "$tree" = "${OS_LAST_TREE:-}" ]; then',
    '  echo "unchanged $head $tree"; exit 0',
    "fi",
    'commit=$(printf \'Open Session checkpoint\\n\\nSession: %s\\nBranch: %s\\nHead: %s\\n\' "$OS_SESSION" "$OS_BRANCH" "$head" | git commit-tree "$tree" -p "$head")',
    'git push --force --quiet origin "$commit:$OS_REF"',
    'echo "pushed $commit $head $tree"',
  ]
    .filter(Boolean)
    .join("\n");
}

export type CheckpointOutcome =
  | { state: "pushed" | "unchanged"; checkpoint: SandboxCheckpointRecord }
  | { state: "skipped"; reason: string };

type CheckpointSession = Pick<
  UnifiedSession,
  "id" | "repo" | "branch" | "worktreeDir" | "sandbox" | "sandboxCheckpoint"
>;

/** Runs the checkpoint script somewhere and returns its exit code and output:
 * inside a Sandbox (`sandbox.exec`) or on this machine (`bun`'s shell). */
type ScriptRunner = (
  script: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * One checkpoint on the session's lane. Callers pass the session record as
 * it stands once the lane is theirs (a queued caller's own copy may be
 * stale). `unchanged` needs no write; `pushed` becomes the session's
 * `sandboxCheckpoint` before the lane is released, so the next checkpoint
 * and the next turn both see it.
 */
async function runCheckpoint(
  session: CheckpointSession,
  cwd: string,
  run: ScriptRunner,
): Promise<CheckpointOutcome> {
  if (!session.branch) return { state: "skipped", reason: "no branch" };
  const repo = getRepo(session.repo);
  if (!checkpointCapable(repo))
    return { state: "skipped", reason: "repository is not on GitHub" };
  if (repo.defaultBranch === session.branch)
    return { state: "skipped", reason: "session is on the default branch" };
  const env = await checkpointGitEnv(repo);
  if (!env) return { state: "skipped", reason: "no GitHub credential" };
  const ref = checkpointRef(session.id);
  const last = session.sandboxCheckpoint;
  const result = await run(checkpointScript(excludedPaths(repo)), {
    ...env,
    OS_CWD: cwd,
    OS_REF: ref,
    OS_SESSION: session.id,
    OS_BRANCH: session.branch,
    OS_LAST_HEAD: last?.ref === ref ? last.head : "",
    OS_LAST_TREE: last?.ref === ref ? last.tree : "",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `checkpoint push failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    );
  }
  const line = result.stdout.trim().split("\n").at(-1) || "";
  const [state, ...parts] = line.split(/\s+/);
  if (state === "unchanged" && last?.ref === ref)
    return { state: "unchanged", checkpoint: last };
  if (state !== "pushed" || parts.length < 3)
    throw new Error(`checkpoint produced no result: ${line.slice(0, 200)}`);
  const checkpoint: SandboxCheckpointRecord = {
    ref,
    commit: parts[0]!,
    head: parts[1]!,
    tree: parts[2]!,
    branch: session.branch,
    at: new Date().toISOString(),
  };
  await touchNativeSessionStrict(session.id, { sandboxCheckpoint: checkpoint });
  console.log(
    `[sandbox] ${session.id}: checkpoint ${checkpoint.commit.slice(0, 12)} on ${ref}`,
  );
  return { state: "pushed", checkpoint };
}

/**
 * Push the session's current workspace state from its Sandbox to origin and
 * record it on the session. Never throws for an expected limitation (no
 * branch, no GitHub credential, codestorage repo); a git failure does.
 * Serialized on the session's lifecycle lane, which is claimed synchronously
 * here; `sandbox` may be a resolver that is only called once the lane is
 * ours, with the session record as it stands then. A resolver that yields
 * null (no reachable Sandbox) makes the checkpoint a no-op `skipped`.
 */
export function checkpointSessionWorkspace(
  session: CheckpointSession,
  sandbox: Sandbox | ((current: CheckpointSession) => Promise<Sandbox | null>),
): Promise<CheckpointOutcome> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = (await findSessionAsync(session.id)) || session;
    if (!isRemoteSandboxProvider(current.sandbox?.provider))
      return { state: "skipped", reason: "not a Sandbox session" };
    const target =
      typeof sandbox === "function" ? await sandbox(current) : sandbox;
    if (!target) return { state: "skipped", reason: "Sandbox not reachable" };
    const cwd = target.cwd || current.worktreeDir;
    if (!cwd) return { state: "skipped", reason: "no workspace" };
    return runCheckpoint(current, cwd, (script, env) =>
      target.exec(["bash", "-c", script], {
        env,
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      }),
    );
  });
}

/**
 * The same checkpoint from a worktree on this machine, for a session moving
 * INTO a Sandbox: its uncommitted work travels with it instead of staying
 * behind. A shared checkout is never checkpointed (the tree is everyone's).
 */
export function checkpointHostWorkspace(
  session: Omit<CheckpointSession, "sandbox">,
  dir: string,
): Promise<CheckpointOutcome> {
  return withSessionLifecycleLane(session.id, async () => {
    if (!existsSync(dir)) return { state: "skipped", reason: "no worktree" };
    if (isSharedCheckoutDir(dir))
      return { state: "skipped", reason: "shared checkout" };
    const current = (await findSessionAsync(session.id)) || session;
    return runCheckpoint(
      { ...current, sandbox: undefined },
      dir,
      async (script, env) => {
        const result = await $`bash -c ${script}`
          .env({ ...process.env, ...env })
          .quiet()
          .nothrow();
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
    );
  });
}

/**
 * Materialize a worktree for `branch` on this machine and restore the
 * checkpoint into it: the branch ends on the checkpoint's head with the
 * checkpointed changes uncommitted. Works whether or not origin has ever seen
 * the branch, because the checkpoint commit carries the branch tip.
 *
 * The restore is `reset --hard`, so it must never land in a checkout that
 * holds someone else's work. Finding, creating, and rewriting the checkout
 * happen as one step under the repository's git lock
 * (`withClaimedBranchWorktree`), so two restores of the same branch cannot
 * both see it free: the first creates and fills the worktree, the second
 * finds it occupied. An occupied checkout is refused, with one exception:
 * the detaching session's own former worktree (`ownWorktreeDir`) is
 * re-adopted when that is provably lossless, that is, its tree is clean and
 * its tip is an ancestor of the checkpoint. Anything else, including a dirty
 * tree of the session's own, is left for a person to look at. A checkpoint
 * taken on another branch than `branch` is refused before anything happens.
 */
export async function restoreCheckpointToHostWorktree(
  repo: Repo,
  branch: string,
  checkpoint: Pick<SandboxCheckpointRecord, "ref" | "commit" | "branch">,
  ownWorktreeDir?: string,
): Promise<string> {
  if (checkpoint.branch !== branch)
    throw new Error(
      `the checkpoint was taken on branch ${checkpoint.branch}, but this session is on ${branch}; it cannot be restored here`,
    );
  const env = await checkpointGitEnv(repo);
  if (!env) throw new Error("no GitHub credential to fetch the checkpoint");
  return withClaimedBranchWorktree(
    branch,
    repo.id,
    env,
    async ({ path: dir, created }) => {
      if (!created) {
        if (dir !== ownWorktreeDir || isSharedCheckoutDir(dir))
          throw new Error(
            `branch ${branch} is already checked out at ${dir} on this machine, and restoring the checkpoint there would overwrite its files. Move or remove that checkout first.`,
          );
        const dirty = (
          await $`git -C ${dir} status --porcelain`.quiet().nothrow().text()
        ).trim();
        if (dirty)
          throw new Error(
            `this session's former worktree at ${dir} has uncommitted changes that the checkpoint would overwrite. Commit, stash, or discard them there first.`,
          );
      }
      const script = `cd ${shellQuoteWord(dir)} && ${checkpointRestoreScript(
        checkpoint.ref,
        checkpoint.commit,
        { branch, onlyForward: !created },
      )}`;
      const result = await $`bash -c ${script}`
        .env({ ...process.env, ...env })
        .quiet()
        .nothrow();
      if (result.exitCode !== 0) {
        throw new Error(
          `checkpoint restore failed: ${result.stderr.toString().trim().slice(0, 400)}`,
        );
      }
      return dir;
    },
  );
}

/** Remove the hidden ref when a session is deleted. Best effort; an archived
 * session keeps its checkpoint because that may be the only copy of its work. */
export async function deleteSessionCheckpoint(
  session: Pick<UnifiedSession, "id" | "repo" | "sandboxCheckpoint">,
): Promise<void> {
  const checkpoint = session.sandboxCheckpoint;
  if (!checkpoint) return;
  let repo: Repo;
  try {
    repo = getRepo(session.repo);
  } catch {
    return;
  }
  if (!checkpointCapable(repo)) return;
  const env = await checkpointGitEnv(repo);
  if (!env) return;
  const result =
    await $`git -C ${repo.repo} push --quiet origin --delete ${checkpoint.ref}`
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    console.warn(
      `[sandbox] ${session.id}: could not delete ${checkpoint.ref}: ${result.stderr.toString().trim().slice(0, 200)}`,
    );
  }
}
