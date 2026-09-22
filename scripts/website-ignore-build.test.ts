import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(
  import.meta.dir,
  "../packages/clients/website/ignore-build.sh",
);
const roots: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "website-ignore-build-"));
  roots.push(root);
  const cwd = join(root, "packages/clients/website");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, env });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (path: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture\n");
    git("add", "--", path);
    git("-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const base = commit("packages/clients/website/.gitkeep");
  const run = (previous = base) =>
    Bun.spawnSync(["sh", script], {
      cwd,
      env: { ...env, VERCEL_GIT_PREVIOUS_SHA: previous },
    }).exitCode;
  return { git, commit, run };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

for (const path of [
  "packages/clients/website/app/page.tsx",
  "packages/clients/website/vercel.json",
  "packages/core/opensession-server/src/frontend/App.tsx",
  "packages/core/opensession-server/src/shared/workflow-types.ts",
  "packages/core/opensession-server/src/server/workflow-types.ts",
  "packages/core/opensession-server/src/simulator-portal/protocol.ts",
  "packages/core/protocol/src/session.ts",
  "packages/clients/mac/build/icon-512.png",
  "packages/clients/ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png",
  "packages/core/opensession-server/package.json",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "patches/example.patch",
]) {
  test(`builds for ${path}`, () => {
    const { commit, run } = fixture();
    commit(path);
    expect(run()).toBe(1);
  });
}

for (const path of [
  "docs/guide.md",
  "packages/core/opensession-server/src/server/routes/example.ts",
  "packages/clients/ios/OS1/Example.swift",
  "packages/clients/chrome/content.ts",
  "deploy/deploy.sh",
]) {
  test(`skips unrelated change to ${path}`, () => {
    const { commit, run } = fixture();
    commit(path);
    expect(run()).toBe(0);
  });
}

test("builds without previous history, skips identical inputs", () => {
  const { run } = fixture();
  expect(run("")).toBe(1);
  expect(run("a".repeat(40))).toBe(1);
  expect(run()).toBe(0);
});

test("compares all commits since the previous deployment", () => {
  const { commit, run } = fixture();
  commit("packages/clients/website/app/page.tsx");
  commit("docs/guide.md");
  expect(run()).toBe(1);
});

test("builds when a website input is deleted", () => {
  const { git, commit, run } = fixture();
  const base = commit("packages/clients/website/old.ts");
  git("rm", "packages/clients/website/old.ts");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "Remove fixture");
  expect(run(base)).toBe(1);
});
