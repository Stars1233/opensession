/**
 * A Sandbox for the dev server alone.
 *
 * A session that lives on this machine keeps its worktree and its agent
 * here; only its Portals run remotely, in a Sandbox provisioned the first
 * time one is started and torn down with the session. That Sandbox's
 * checkout is nobody's work: it is a clone of the session branch landed on
 * the session's checkpoints (sandbox/checkpoint.ts), refreshed after every
 * clean turn and whenever a Portal is started or the Sandbox wakes, so the
 * running app shows what the agent has done without a file-sync channel.
 * The repository opts in per project (`perRepo[repo].portalSandbox`).
 *
 * A session that already runs in a workspace Sandbox, or on a Runner, runs
 * its Portals there and never gets one of these.
 */

import { getSandboxProvider, type Sandbox } from "./sandbox";
import {
  checkpointHostWorkspace,
  landCheckpointInSandbox,
} from "./sandbox/checkpoint";
import {
  isRemoteSandboxProvider,
  repoPortalSandbox,
  sandboxesEnabled,
  sandboxProviderUsability,
} from "./sandbox/config";
import { withSessionLifecycleLane } from "./sandbox/lifecycle-lane";
import { ensureSandboxWithTransientRetry } from "./sandbox/reliability";
import {
  findSessionAsync,
  touchNativeSession,
  touchNativeSessionStrict,
} from "./session-cache";
import {
  activePortalSandboxFor,
  activeSandboxFor,
  recordedSandboxGone,
  teardownSandbox,
} from "./session-sandbox";
import type { UnifiedSession } from "./types";

/** Providers key their resources by the spec's session id; the Portal
 * Sandbox is a second resource of the same session, so it gets its own. */
export const PORTAL_SANDBOX_SUFFIX = "--portals";

export function portalSandboxSessionId(sessionId: string): string {
  return `${sessionId}${PORTAL_SANDBOX_SUFFIX}`;
}

type PortalSession = Pick<
  UnifiedSession,
  | "id"
  | "source"
  | "sandbox"
  | "portalSandbox"
  | "runner"
  | "repo"
  | "mode"
  | "branch"
  | "worktreeDir"
  | "automationId"
  | "automation"
>;

/**
 * The provider a Portal Sandbox for `session` would use, or null when its
 * Portals run beside it: in its workspace Sandbox, on its Runner, or on this
 * machine because the project did not ask for one or the provider is not
 * usable right now.
 */
export function portalSandboxProvider(session: PortalSession): string | null {
  if (session.source !== "opensession") return null;
  if (session.runner) return null;
  if (
    session.sandbox?.sandboxId ||
    isRemoteSandboxProvider(session.sandbox?.provider)
  )
    return null;
  if (session.automationId || session.automation) return null;
  if (session.mode !== "code" || !session.repo || !session.branch) return null;
  if (!session.worktreeDir) return null;
  if (!sandboxesEnabled()) return null;
  const provider = repoPortalSandbox(session.repo);
  if (!provider || sandboxProviderUsability(provider).state !== "usable")
    return null;
  return provider;
}

/** Whether this session's Portals run in a Sandbox at all: its workspace
 * Sandbox, the Portal Sandbox it already has, or the one its project asks
 * for. Decides whether "no live Sandbox" is a refusal or means "on this
 * machine". */
export function portalsInSandbox(session: PortalSession): boolean {
  return Boolean(
    session.sandbox?.sandboxId ||
    session.portalSandbox?.sandboxId ||
    portalSandboxProvider(session),
  );
}

/**
 * The Sandbox that runs this session's Portals: its workspace Sandbox, its
 * Portal Sandbox, or, with `provision`, a Portal Sandbox created now for a
 * project that runs Portals remotely. `wake` is an explicit compute action
 * (starting or restarting a Portal): it may wake a sleeping machine and
 * lands the latest host checkpoint in a Portal Sandbox first, so the app
 * that comes up shows the current tree; when that landing fails the wake
 * fails with it, rather than starting the app on whatever the machine had
 * before. A Portal Sandbox the provider has lost is replaced when
 * provisioning is allowed. Throws when provisioning or the landing fails;
 * the reason is recorded on the session as well.
 */
export async function sandboxForPortals(
  session: UnifiedSession,
  options: { wake?: boolean; provision?: boolean } = {},
): Promise<Sandbox | null> {
  if (session.sandbox?.sandboxId)
    return activeSandboxFor(session, { wake: options.wake });
  const record = session.portalSandbox;
  if (record?.sandboxId) {
    const sandbox = await activePortalSandboxFor(session, {
      wake: options.wake,
    });
    if (sandbox) {
      if (options.wake) await syncPortalSandbox(session, sandbox);
      return sandbox;
    }
    if (
      !options.provision ||
      !(await recordedSandboxGone({ ...record, sandboxId: record.sandboxId }))
    )
      return null;
    console.warn(
      `[sandbox] ${session.id}: Portal Sandbox ${record.sandboxId} is gone; replacing it`,
    );
  }
  if (!options.provision) return null;
  const provider = portalSandboxProvider(session);
  if (!provider) return null;
  return provisionPortalSandbox(session, provider);
}

/**
 * Create the Portal Sandbox: checkpoint the host worktree so uncommitted
 * work travels too, then materialize a workspace on the checkpoint. The
 * provisioning itself is not on the lifecycle lane (the checkpoint claims it
 * for itself): a machine can take a minute to come up and turns need not
 * wait for it. Taking ownership is: the final owner check and the record
 * write happen on the lane, where deletion and moves also run, so the
 * machine is either recorded on a session that still wants it (and goes
 * with that session) or torn down here; a session deleted or moved into a
 * Sandbox meanwhile gets no Portal Sandbox.
 */
async function provisionPortalSandbox(
  session: UnifiedSession,
  provider: string,
): Promise<Sandbox> {
  const dir = session.worktreeDir!;
  await touchNativeSessionStrict(session.id, {
    portalSandbox: { provider, lifecycle: "preparing" },
  });
  // Cleared when the session no longer wants a Portal Sandbox (deleted or
  // moved): its record is not this call's to write any more.
  let owned = true;
  try {
    // The machine mirrors this worktree, and the checkpoint just taken is
    // the only faithful copy of it. A worktree that cannot be checkpointed
    // (not on GitHub, on the default branch, no credential) gets no Portal
    // Sandbox rather than one built from origin that shows older code.
    const outcome = await checkpointHostWorkspace(session, dir);
    if (outcome.state === "skipped")
      throw new Error(
        `this worktree cannot be checkpointed (${outcome.reason}), and the Portal Sandbox would show older code`,
      );
    const checkpoint = outcome.checkpoint;
    const current = await findSessionAsync(session.id);
    if (!current) throw new Error("the session was deleted");
    const sandbox = await ensureSandboxWithTransientRetry(
      getSandboxProvider(provider),
      {
        sessionId: portalSandboxSessionId(session.id),
        repo: current.repo,
        branch: checkpoint.branch,
        mode: "code",
        restoreCheckpoint: {
          ref: checkpoint.ref,
          commit: checkpoint.commit,
          branch: checkpoint.branch,
        },
      },
    );
    try {
      await withSessionLifecycleLane(session.id, async () => {
        const owner = await findSessionAsync(session.id);
        if (
          !owner ||
          owner.sandbox?.sandboxId ||
          owner.portalSandbox?.provider !== provider
        )
          throw new Error(
            owner
              ? "the session moved while its Portal Sandbox was being prepared"
              : "the session was deleted",
          );
        await touchNativeSessionStrict(session.id, {
          portalSandbox: {
            provider,
            sandboxId: sandbox.id,
            lifecycle: "awake",
            lastLifecycleError: undefined,
            syncedCommit: checkpoint.commit,
          },
        });
      });
    } catch (error) {
      // Not recorded on any session (gone, moved, or the write itself was
      // refused): nothing else will ever tear this machine down.
      owned = false;
      await teardownSandbox(provider, sandbox.id).catch((teardownError) =>
        console.warn(
          `[sandbox] ${session.id}: unowned Portal Sandbox ${sandbox.id} not destroyed:`,
          teardownError instanceof Error
            ? teardownError.message
            : String(teardownError),
        ),
      );
      throw error;
    }
    console.log(
      `[sandbox] ${session.id}: Portal Sandbox ${sandbox.id} ready on checkpoint ${checkpoint.commit.slice(0, 12)}`,
    );
    return sandbox;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (owned)
      touchNativeSession(session.id, {
        portalSandbox: {
          provider,
          lifecycle: "needs_attention",
          lastLifecycleError: message.slice(0, 240),
        },
      });
    throw new Error(`Could not prepare the Portal Sandbox: ${message}`);
  }
}

/**
 * Bring the Portal Sandbox's checkout up to the host worktree: checkpoint
 * the worktree and land the checkpoint there, on the session's lifecycle
 * lane so the capture and the landing see one consistent record. `current`
 * when the Sandbox already sits on the latest checkpoint; `skipped` only
 * when the machine is not this session's Portal Sandbox any more. A failed
 * capture or landing throws, and so does a capture the worktree does not
 * allow (no branch, the default branch, no credential), with the reason
 * recorded on the session for the Portals panel: the machine then holds an
 * older tree, and a wake that went on regardless would report the app
 * ready on stale code.
 */
export function syncPortalSandbox(
  session: UnifiedSession,
  sandbox: Sandbox,
): Promise<"landed" | "current" | "skipped"> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = await findSessionAsync(session.id);
    const record = current?.portalSandbox;
    if (!current?.worktreeDir || record?.sandboxId !== sandbox.id)
      return "skipped";
    try {
      const outcome = await checkpointHostWorkspace(
        current,
        current.worktreeDir,
      );
      if (outcome.state === "skipped")
        throw new Error(
          `this worktree cannot be checkpointed (${outcome.reason}), and the Portal Sandbox holds older code`,
        );
      if (outcome.checkpoint.commit === record.syncedCommit) return "current";
      await landCheckpointInSandbox(current.repo, sandbox, outcome.checkpoint);
      await touchNativeSessionStrict(current.id, {
        portalSandbox: {
          ...record,
          lastLifecycleError: undefined,
          syncedCommit: outcome.checkpoint.commit,
        },
      });
      console.log(
        `[sandbox] ${current.id}: Portal Sandbox on checkpoint ${outcome.checkpoint.commit.slice(0, 12)}`,
      );
      return "landed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      touchNativeSession(current.id, {
        portalSandbox: { ...record, lastLifecycleError: message.slice(0, 240) },
      });
      throw new Error(`Could not refresh the Portal Sandbox: ${message}`);
    }
  });
}

/**
 * After a clean turn on this machine: refresh the Portal Sandbox if it is
 * awake (a sleeping one lands the checkpoint when a Portal wakes it). Claims
 * the lane synchronously, like the Sandbox session's own post-turn
 * checkpoint, so the next turn waits for the capture.
 */
export function syncPortalSandboxAfterTurn(
  session: UnifiedSession,
): Promise<void> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = await findSessionAsync(session.id);
    if (!current?.portalSandbox?.sandboxId) return;
    const sandbox = await activePortalSandboxFor(current);
    if (!sandbox) return;
    await syncPortalSandbox(current, sandbox);
  });
}

/** Retire a session's Portal Sandbox (a move into a workspace Sandbox, whose
 * Portals run there). Best-effort on the machine; the record always goes. */
export async function releasePortalSandbox(
  session: UnifiedSession,
  why: string,
): Promise<void> {
  const record = session.portalSandbox;
  if (!record) return;
  if (record.sandboxId && isRemoteSandboxProvider(record.provider)) {
    try {
      await teardownSandbox(record.provider, record.sandboxId);
      console.log(
        `[sandbox] ${session.id}: Portal Sandbox ${record.sandboxId} destroyed (${why})`,
      );
    } catch (error) {
      console.warn(
        `[sandbox] ${session.id}: Portal Sandbox ${record.sandboxId} not destroyed (${why}):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await touchNativeSessionStrict(session.id, { portalSandbox: undefined });
}
