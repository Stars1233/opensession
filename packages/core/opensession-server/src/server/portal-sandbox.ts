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
  restorableCheckpoint,
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
 * that comes up shows the current tree. A Portal Sandbox the provider has
 * lost is replaced when provisioning is allowed. Throws when provisioning
 * fails; the reason is recorded on the session as well.
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
      if (options.wake)
        await syncPortalSandbox(session, sandbox).catch((error) =>
          console.warn(
            `[sandbox] ${session.id}: Portal Sandbox not refreshed:`,
            error instanceof Error ? error.message : String(error),
          ),
        );
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
 * work travels too, then materialize a workspace on the checkpoint. Not on
 * the lifecycle lane (the checkpoint claims it for itself): a machine can
 * take a minute to come up and turns need not wait for it. A session
 * deleted or moved into a Sandbox meanwhile gets no Portal Sandbox; the one
 * just created is torn down again.
 */
async function provisionPortalSandbox(
  session: UnifiedSession,
  provider: string,
): Promise<Sandbox> {
  const dir = session.worktreeDir!;
  await touchNativeSessionStrict(session.id, {
    portalSandbox: { provider, lifecycle: "preparing" },
  });
  try {
    const outcome = await checkpointHostWorkspace(session, dir);
    if (outcome.state === "skipped")
      console.log(
        `[sandbox] ${session.id}: Portal Sandbox starts from origin (checkpoint skipped: ${outcome.reason})`,
      );
    const current = await findSessionAsync(session.id);
    if (!current) throw new Error("the session was deleted");
    const checkpoint = restorableCheckpoint(current);
    const sandbox = await ensureSandboxWithTransientRetry(
      getSandboxProvider(provider),
      {
        sessionId: portalSandboxSessionId(session.id),
        repo: current.repo,
        branch: current.branch || undefined,
        mode: "code",
        ...(checkpoint
          ? {
              restoreCheckpoint: {
                ref: checkpoint.ref,
                commit: checkpoint.commit,
                branch: checkpoint.branch,
              },
            }
          : {}),
      },
    );
    const owner = await findSessionAsync(session.id);
    if (
      !owner ||
      owner.sandbox?.sandboxId ||
      owner.portalSandbox?.provider !== provider
    ) {
      await teardownSandbox(provider, sandbox.id).catch(() => {});
      throw new Error(
        owner
          ? "the session moved while its Portal Sandbox was being prepared"
          : "the session was deleted",
      );
    }
    await touchNativeSessionStrict(session.id, {
      portalSandbox: {
        provider,
        sandboxId: sandbox.id,
        lifecycle: "awake",
        lastLifecycleError: undefined,
        syncedCommit: checkpoint?.commit,
      },
    });
    console.log(
      `[sandbox] ${session.id}: Portal Sandbox ${sandbox.id} ready` +
        (checkpoint ? ` on checkpoint ${checkpoint.commit.slice(0, 12)}` : ""),
    );
    return sandbox;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
 * when the Sandbox already sits on the latest checkpoint.
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
    const outcome = await checkpointHostWorkspace(current, current.worktreeDir);
    if (outcome.state === "skipped") return "skipped";
    if (outcome.checkpoint.commit === record.syncedCommit) return "current";
    await landCheckpointInSandbox(current.repo, sandbox, outcome.checkpoint);
    await touchNativeSessionStrict(current.id, {
      portalSandbox: { ...record, syncedCommit: outcome.checkpoint.commit },
    });
    console.log(
      `[sandbox] ${current.id}: Portal Sandbox on checkpoint ${outcome.checkpoint.commit.slice(0, 12)}`,
    );
    return "landed";
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
