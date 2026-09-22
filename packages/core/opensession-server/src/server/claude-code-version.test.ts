import { describe, expect, test } from "bun:test";
import {
  claudeCodeVersionSatisfies,
  ensureClaudeCodeVersion,
  parseClaudeCodeVersion,
  type Exec,
} from "./claude-code-version";

/** Fake CLI: `--version` reports `version`, `update` moves it to `updatesTo`. */
function fakeCli(version: string | null, updatesTo?: string) {
  const calls: string[][] = [];
  let current = version;
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[1] === "update") {
      if (!updatesTo) return { code: 1, output: "update failed: EACCES" };
      current = updatesTo;
      return { code: 0, output: `Successfully updated to ${updatesTo}` };
    }
    if (current === null) return { code: -1, output: "ENOENT" };
    return { code: 0, output: `${current} (Claude Code)` };
  };
  return { exec, calls };
}

describe("Claude Code version", () => {
  test("parses and compares numerically, not lexically", () => {
    expect(parseClaudeCodeVersion("2.1.280 (Claude Code)")).toEqual([
      2, 1, 280,
    ]);
    expect(parseClaudeCodeVersion("claude")).toBeNull();
    expect(claudeCodeVersionSatisfies("2.1.280", "2.1.280")).toBe(true);
    expect(claudeCodeVersionSatisfies("2.1.257", "2.1.280")).toBe(false);
    expect(claudeCodeVersionSatisfies("2.1.1000", "2.1.280")).toBe(true);
    expect(claudeCodeVersionSatisfies("2.2.0", "2.1.280")).toBe(true);
    expect(claudeCodeVersionSatisfies("garbage", "2.1.280")).toBeNull();
  });

  test("leaves a current CLI alone", async () => {
    const cli = fakeCli("2.1.281");
    expect(
      await ensureClaudeCodeVersion({
        bin: "claude",
        min: "2.1.280",
        exec: cli.exec,
      }),
    ).toEqual({ status: "current", version: "2.1.281" });
    expect(cli.calls).toEqual([["claude", "--version"]]);
  });

  test("updates an outdated CLI and confirms the new version", async () => {
    const cli = fakeCli("2.1.257", "2.1.280");
    expect(
      await ensureClaudeCodeVersion({
        bin: "claude",
        min: "2.1.280",
        exec: cli.exec,
      }),
    ).toEqual({ status: "upgraded", from: "2.1.257", to: "2.1.280" });
    expect(cli.calls.map((argv) => argv[1])).toEqual([
      "--version",
      "update",
      "--version",
    ]);
  });

  test("reports a failed update instead of claiming success", async () => {
    const cli = fakeCli("2.1.257");
    const result = await ensureClaudeCodeVersion({
      bin: "claude",
      min: "2.1.280",
      exec: cli.exec,
    });
    expect(result).toMatchObject({ status: "failed", from: "2.1.257" });
    expect(result.status === "failed" && result.error).toContain("EACCES");
  });

  test("does not try to update a missing CLI", async () => {
    const cli = fakeCli(null);
    expect(
      (await ensureClaudeCodeVersion({ bin: "claude", exec: cli.exec })).status,
    ).toBe("missing");
    expect(cli.calls).toHaveLength(1);
  });
});
