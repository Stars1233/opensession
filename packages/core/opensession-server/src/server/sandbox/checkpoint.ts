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
 */

import { $ } from "bun";
import { githubServiceCredentialEnv } from "../github-app";
import { touchNativeSessionStrict } from "../session-cache";
import type { SandboxCheckpointRecord, UnifiedSession } from "../types";
import {
  createWorktree,
  createWorktreeForExistingBranch,
  getRepo,
  isSharedCheckoutDir,
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

/**
 * Push the session's current workspace state from `sandbox` to origin and
 * record it on the session. Never throws for an expected limitation (no
 * branch, no GitHub credential, codestorage repo); a git failure does.
 */
export async function checkpointSessionWorkspace(
  session: Pick<
    UnifiedSession,
    "id" | "repo" | "branch" | "worktreeDir" | "sandbox" | "sandboxCheckpoint"
  >,
  sandbox: Sandbox,
): Promise<CheckpointOutcome> {
  if (!isRemoteSandboxProvider(session.sandbox?.provider))
    return { state: "skipped", reason: "not a Sandbox session" };
  if (!session.branch) return { state: "skipped", reason: "no branch" };
  const cwd = sandbox.cwd || session.worktreeDir;
  if (!cwd) return { state: "skipped", reason: "no workspace" };
  const repo = getRepo(session.repo);
  if (!checkpointCapable(repo))
    return { state: "skipped", reason: "repository is not on GitHub" };
  if (repo.defaultBranch === session.branch)
    return { state: "skipped", reason: "session is on the default branch" };
  const env = await checkpointGitEnv(repo);
  if (!env) return { state: "skipped", reason: "no GitHub credential" };
  const ref = checkpointRef(session.id);
  const last = session.sandboxCheckpoint;
  const result = await sandbox.exec(
    ["bash", "-c", checkpointScript(excludedPaths(repo))],
    {
      env: {
        ...env,
        OS_CWD: cwd,
        OS_REF: ref,
        OS_SESSION: session.id,
        OS_BRANCH: session.branch,
        OS_LAST_HEAD: last?.ref === ref ? last.head : "",
        OS_LAST_TREE: last?.ref === ref ? last.tree : "",
      },
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
    },
  );
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
 * The same checkpoint from a worktree on this machine, for a session moving
 * INTO a Sandbox: its uncommitted work travels with it instead of staying
 * behind. A shared checkout is never checkpointed (the tree is everyone's).
 */
export async function checkpointHostWorkspace(
  session: Pick<
    UnifiedSession,
    "id" | "repo" | "branch" | "worktreeDir" | "sandboxCheckpoint"
  >,
  dir: string,
): Promise<CheckpointOutcome> {
  if (!session.branch) return { state: "skipped", reason: "no branch" };
  if (!existsSync(dir)) return { state: "skipped", reason: "no worktree" };
  if (isSharedCheckoutDir(dir))
    return { state: "skipped", reason: "shared checkout" };
  const repo = getRepo(session.repo);
  if (!checkpointCapable(repo))
    return { state: "skipped", reason: "repository is not on GitHub" };
  if (repo.defaultBranch === session.branch)
    return { state: "skipped", reason: "session is on the default branch" };
  const env = await checkpointGitEnv(repo);
  if (!env) return { state: "skipped", reason: "no GitHub credential" };
  const ref = checkpointRef(session.id);
  const last = session.sandboxCheckpoint;
  const result = await $`bash -c ${checkpointScript(excludedPaths(repo))}`
    .env({
      ...process.env,
      ...env,
      OS_CWD: dir,
      OS_REF: ref,
      OS_SESSION: session.id,
      OS_BRANCH: session.branch,
      OS_LAST_HEAD: last?.ref === ref ? last.head : "",
      OS_LAST_TREE: last?.ref === ref ? last.tree : "",
    })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `checkpoint push failed: ${result.stderr.toString().trim().slice(0, 400)}`,
    );
  }
  const line = result.stdout.toString().trim().split("\n").at(-1) || "";
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
  return { state: "pushed", checkpoint };
}

/**
 * Materialize a worktree for `branch` on this machine and restore the
 * checkpoint into it: the branch ends on the checkpoint's head with the
 * checkpointed changes uncommitted. Works whether or not origin has ever seen
 * the branch, because the checkpoint commit carries the branch tip.
 */
export async function restoreCheckpointToHostWorktree(
  repo: Repo,
  branch: string,
  checkpoint: Pick<SandboxCheckpointRecord, "ref" | "commit">,
): Promise<string> {
  const env = await checkpointGitEnv(repo);
  if (!env) throw new Error("no GitHub credential to fetch the checkpoint");
  let dir: string;
  try {
    dir = await createWorktreeForExistingBranch(branch, repo.id, env);
  } catch {
    // Neither origin nor this machine knows the branch: start it anywhere and
    // let the restore below move it onto the checkpoint's head.
    dir = await createWorktree(branch, repo.id, {
      isolated: true,
      gitEnv: env,
    });
  }
  const script = `cd ${shellQuoteWord(dir)} && ${checkpointRestoreScript(checkpoint.ref, checkpoint.commit)}`;
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
