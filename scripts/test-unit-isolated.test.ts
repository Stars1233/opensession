import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("isolated unit runner selects exact files, not artifact copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolated-test-paths-"));
  try {
    const source = "packages/core/opensession-server/src";
    await mkdir(join(root, source), { recursive: true });
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "artifacts/copy", source), { recursive: true });
    await writeFile(
      join(root, source, "example.test.ts"),
      'import { test, expect } from "bun:test"; test("source", () => expect(true).toBe(true));',
    );
    await writeFile(
      join(root, "artifacts/copy", source, "example.test.ts"),
      'throw new Error("must not execute artifact copies");',
    );
    const proc = Bun.spawn(
      ["bash", join(import.meta.dir, "test-unit-isolated.sh")],
      {
        cwd: root,
        env: { ...process.env, OPENSESSION_TEST_JOBS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({
      code,
      output: stderr.includes("must not execute artifact copies"),
    }).toEqual({
      code: 0,
      output: false,
    });
    expect(stdout).toContain("Running 1 unit-test files");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
