#!/usr/bin/env bun
/**
 * Seed the session catalogs from the legacy session source files.
 *
 * The gateway builds its session list from the list index and, for a cold
 * rebuild, from the catalogs only; it never lists a session directory. This
 * script is the one place those directories are read for the live store:
 *
 * - `<sessions dir>/<id>.json`, native documents written before the actor
 *   owned their metadata, and the sidecars stored under Slack/Linear ids, are
 *   projected into the session metadata catalog as-is (rev = the file's rev,
 *   or 1; exported_rev = rev, since the file already carries it);
 * - `~/.slack-sessions/*.json` and `~/.linear-sessions/*.json`, the
 *   agent-owned source files, are projected into the `slack-sessions` and
 *   `linear-sessions` catalog-document namespaces.
 *
 * A row that already exists (an earlier run, a live commit, a mirror written
 * by a targeted read) is left alone, and the per-session actor document
 * still materializes from the file on that session's first real write. No
 * per-session actor database is opened.
 *
 * Runs online against the live session kernel service through the transport
 * the gateway uses, so the kernel URL and credential resolve the same way
 * (OPENSESSION_SESSION_KERNEL_URL or _HOST/_PORT, and
 * OPENSESSION_SESSION_KERNEL_TOKEN or OPENSESSION_SESSION_KERNEL_TOKEN_FILE).
 * Re-running is safe. Once every file has a row the catalogs are marked
 * complete; from then on a cold list rebuild pages them instead of scanning.
 * Until they are, a gateway whose list index has lost coverage serves no
 * session list at all (SessionListUnavailableError), so run this before a
 * rollout that rebuilds the index.
 *
 *   bun scripts/seed-session-metadata-catalog.ts [--dry-run] [--no-mark-complete] [--batch 200]
 */

export {};

// The scanner refuses to run in a live gateway; this process is an operator
// script, which it announces before the server modules load.
process.env.OPENSESSION_OFFLINE_SESSION_SCAN = "1";

const { startSessionKernelActor, stopSessionKernelActor } =
  await import("../packages/core/opensession-server/src/server/session-kernel/actor-runtime");
const { seedSessionCatalogsFromFiles } =
  await import("../packages/core/opensession-server/src/server/session-source-scan");

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  await startSessionKernelActor();
  try {
    const summary = await seedSessionCatalogsFromFiles({
      dryRun: flag("--dry-run"),
      markComplete: !flag("--no-mark-complete"),
      batchSize: Number(value("--batch") ?? 200) || 200,
      log: (line) => console.log(line),
    });
    console.log(
      `[seed-session-catalogs] done in ${summary.ms}ms: metadata ` +
        `${summary.native.alreadyComplete || summary.native.markedComplete ? "complete" : "NOT complete"}, ` +
        `slack ${summary.agents.slack.alreadyComplete || summary.agents.slack.markedComplete ? "complete" : "NOT complete"}, ` +
        `linear ${summary.agents.linear.alreadyComplete || summary.agents.linear.markedComplete ? "complete" : "NOT complete"}`,
    );
  } finally {
    stopSessionKernelActor();
  }
}

await main();
