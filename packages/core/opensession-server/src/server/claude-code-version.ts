/**
 * Keep the installed Claude Code CLI at or above the version this release
 * needs.
 *
 * The Anthropic provider paths run every Claude turn through the installed
 * `claude` binary (config `paths.claudeBin`), not a bundled copy. The installer
 * only puts it on the box once, so a server update that starts using a newer
 * Claude model can leave that binary behind; the API then rejects every turn
 * with "Claude Code <x> does not support this model". Bump
 * MIN_CLAUDE_CODE_VERSION in the release that needs a newer CLI, and every
 * install upgrades on its next boot, whichever updater moved the code.
 *
 * Operators who manage the CLI themselves set OPENSESSION_CLAUDE_AUTO_UPDATE=0;
 * `opensession doctor` still reports an outdated binary.
 */
import { audit } from "./audit";
import { configuredPaths } from "./config";

/** Oldest Claude Code CLI this release supports (Claude Opus 5.5 needs it). */
export const MIN_CLAUDE_CODE_VERSION = "2.1.280";

const VERSION_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;

type Version = [number, number, number];

/** First `x.y.z` in `claude --version` output ("2.1.280 (Claude Code)"). */
export function parseClaudeCodeVersion(output: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `output` names a version at or above `min`; null when unparsable. */
export function claudeCodeVersionSatisfies(
  output: string,
  min: string = MIN_CLAUDE_CODE_VERSION,
): boolean | null {
  const have = parseClaudeCodeVersion(output);
  const want = parseClaudeCodeVersion(min);
  if (!have || !want) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

export interface ExecResult {
  code: number;
  output: string;
}

export type Exec = (argv: string[], timeoutMs: number) => Promise<ExecResult>;

const execAsync: Exec = async (argv, timeoutMs) => {
  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: timeoutMs,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, output: `${stdout}\n${stderr}`.trim() };
  } catch (error) {
    return { code: -1, output: String(error) };
  }
};

export type ClaudeCodeUpgradeResult =
  | { status: "current"; version: string }
  | { status: "upgraded"; from: string; to: string }
  | { status: "missing"; error: string }
  | { status: "failed"; from: string; error: string };

/**
 * Check the CLI and run `claude update` when it is older than `min`. Never
 * throws; the result says what happened.
 */
export async function ensureClaudeCodeVersion(
  opts: { bin?: string; min?: string; exec?: Exec } = {},
): Promise<ClaudeCodeUpgradeResult> {
  const bin = opts.bin ?? configuredPaths().claudeBin;
  const min = opts.min ?? MIN_CLAUDE_CODE_VERSION;
  const exec = opts.exec ?? execAsync;

  const before = await exec([bin, "--version"], VERSION_TIMEOUT_MS);
  const current =
    before.code === 0 ? parseClaudeCodeVersion(before.output) : null;
  if (!current) {
    return {
      status: "missing",
      error: before.output || `${bin} --version failed`,
    };
  }
  const from = current.join(".");
  if (claudeCodeVersionSatisfies(from, min)) {
    return { status: "current", version: from };
  }

  const update = await exec([bin, "update"], UPDATE_TIMEOUT_MS);
  const after = await exec([bin, "--version"], VERSION_TIMEOUT_MS);
  const to = parseClaudeCodeVersion(after.output)?.join(".");
  if (after.code === 0 && to && claudeCodeVersionSatisfies(to, min)) {
    return { status: "upgraded", from, to };
  }
  return {
    status: "failed",
    from,
    error:
      update.output.split("\n").slice(-5).join("\n") ||
      `claude update exited ${update.code}`,
  };
}

const g = globalThis as typeof globalThis & {
  __claudeCodeUpgrade?: Promise<ClaudeCodeUpgradeResult | null>;
};

/**
 * Boot entry point: one background check per process. Skipped when the
 * operator opts out.
 */
export function startClaudeCodeUpgrade(): Promise<ClaudeCodeUpgradeResult | null> {
  if (g.__claudeCodeUpgrade) return g.__claudeCodeUpgrade;
  if (process.env.OPENSESSION_CLAUDE_AUTO_UPDATE === "0") {
    return (g.__claudeCodeUpgrade = Promise.resolve(null));
  }
  return (g.__claudeCodeUpgrade = ensureClaudeCodeVersion().then((result) => {
    switch (result.status) {
      case "current":
        break;
      case "upgraded":
        console.log(
          `[claude-code] upgraded ${result.from} -> ${result.to} (needs >= ${MIN_CLAUDE_CODE_VERSION})`,
        );
        audit({ type: "claude_code_upgraded", ...result });
        break;
      case "missing":
        console.warn(
          `[claude-code] CLI not runnable; Claude turns need >= ${MIN_CLAUDE_CODE_VERSION}: ${result.error}`,
        );
        break;
      case "failed":
        console.error(
          `[claude-code] ${result.from} is older than ${MIN_CLAUDE_CODE_VERSION} and \`claude update\` did not fix it; newer Claude models will fail: ${result.error}`,
        );
        audit({ type: "claude_code_upgrade_failed", ...result });
        break;
    }
    return result;
  }));
}
