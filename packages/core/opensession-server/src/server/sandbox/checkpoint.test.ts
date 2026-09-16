/**
 * The checkpoint round trip against a local bare "origin": the script pushes
 * one synthetic commit holding the branch tip plus the dirty tree to the
 * hidden ref, and the restore script reproduces branch, tip, and uncommitted
 * changes in a fresh clone. Pure git, no provider or network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkpointRestoreScript } from "./adapters/bootstrap";
import {
  checkpointCapable,
  checkpointRef,
  checkpointScript,
  settleSessionCheckpoints,
  withCheckpointLane,
} from "./checkpoint";

let scratch: string;
let origin: string;
let work: string;
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string) => $.cwd(cwd).env({ ...process.env, ...identity });

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-checkpoint-"));
  origin = join(scratch, "origin.git");
  work = join(scratch, "work");
  await git(scratch)`git init --bare -q --initial-branch=main origin.git`;
  await git(scratch)`git clone -q ${origin} work`;
  writeFileSync(join(work, "README.md"), "hello\n");
  writeFileSync(join(work, ".gitignore"), "ignored.txt\n");
  await git(work)`git add -A`;
  await git(work)`git commit -q -m init`;
  await git(work)`git push -q origin main`;
  await git(work)`git checkout -q -b feature`;
  writeFileSync(join(work, "README.md"), "hello\nfeature\n");
  await git(work)`git commit -q -am feature`;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ref = checkpointRef("os-test-session");

async function runCheckpoint(env: Record<string, string>) {
  return git(work)`bash -c ${checkpointScript([".ports.conf", "secrets/.env"])}`
    .env({
      ...process.env,
      ...identity,
      OS_CWD: work,
      OS_REF: ref,
      OS_SESSION: "os-test-session",
      OS_BRANCH: "feature",
      OS_LAST_HEAD: "",
      OS_LAST_TREE: "",
      ...env,
    })
    .quiet()
    .nothrow();
}

describe("checkpointCapable", () => {
  test("needs a GitHub repository", () => {
    expect(checkpointCapable({ ghRepo: "tellahq/x" })).toBe(true);
    expect(checkpointCapable({ ghRepo: "" })).toBe(false);
    expect(
      checkpointCapable({ ghRepo: "tellahq/x", host: "codestorage" }),
    ).toBe(false);
  });
});

describe("checkpoint lane", () => {
  test("runs a session's checkpoints one at a time, in order, and a turn waits for them", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withCheckpointLane("s1", async () => {
      order.push("first start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first end");
      return 1;
    });
    const second = withCheckpointLane("s1", async () => {
      order.push("second");
      return 2;
    });
    // Claimed synchronously: a turn asking now already has to wait.
    let turnStarted = false;
    const turn = settleSessionCheckpoints("s1").then(() => {
      turnStarted = true;
    });
    await Promise.resolve();
    expect(order).toEqual(["first start"]);
    expect(turnStarted).toBe(false);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    await turn;
    expect(order).toEqual(["first start", "first end", "second"]);
    expect(turnStarted).toBe(true);
  });

  test("a failed checkpoint neither blocks the lane nor fails the waiting turn", async () => {
    const failed = withCheckpointLane("s2", async () => {
      throw new Error("push refused");
    });
    const next = withCheckpointLane("s2", async () => "ok");
    await expect(failed).rejects.toThrow("push refused");
    expect(await next).toBe("ok");
    await expect(settleSessionCheckpoints("s2")).resolves.toBeUndefined();
  });

  test("other sessions do not wait", async () => {
    let release!: () => void;
    void withCheckpointLane(
      "s3",
      () => new Promise<void>((r) => (release = r)),
    );
    let otherRan = false;
    await withCheckpointLane("s4", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);
    release();
    await settleSessionCheckpoints("s3");
  });
});

describe("checkpoint script", () => {
  test("pushes tip + dirty tree to the hidden ref, leaving out ignored, excluded, and Portal state", async () => {
    writeFileSync(join(work, "README.md"), "hello\nfeature\ndirty\n");
    writeFileSync(join(work, "new.txt"), "untracked\n");
    writeFileSync(join(work, "ignored.txt"), "never\n");
    writeFileSync(join(work, ".ports.conf"), "WEBAPP_PORT=3300\n");
    await $`mkdir -p ${join(work, "secrets")}`;
    writeFileSync(join(work, "secrets/.env"), "SECRET=1\n");

    const result = await runCheckpoint({});
    expect(result.exitCode).toBe(0);
    const [state, commit, head] = result.stdout.toString().trim().split(/\s+/);
    expect(state).toBe("pushed");
    const tip = (await git(work)`git rev-parse HEAD`.text()).trim();
    expect(head).toBe(tip);
    // The branch itself did not move and the tree is still dirty.
    expect((await git(work)`git rev-parse feature`.text()).trim()).toBe(tip);
    expect((await git(work)`git status --porcelain`.text()).trim()).not.toBe(
      "",
    );
    // Origin holds the ref; the checkpoint's parent is the tip.
    const onOrigin = (await git(origin)`git rev-parse ${ref}`.text()).trim();
    expect(onOrigin).toBe(commit);
    expect((await git(origin)`git rev-parse ${ref}^`.text()).trim()).toBe(tip);
    const files = (await git(origin)`git ls-tree -r --name-only ${ref}`.text())
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual([".gitignore", "README.md", "new.txt"]);
  });

  test("reports unchanged when the last checkpoint already holds this state", async () => {
    const first = await runCheckpoint({});
    const [, , head, tree] = first.stdout.toString().trim().split(/\s+/);
    const again = await runCheckpoint({
      OS_LAST_HEAD: head!,
      OS_LAST_TREE: tree!,
    });
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString().trim()).toBe(`unchanged ${head} ${tree}`);
  });

  test("restore reproduces branch, tip, and uncommitted changes in a fresh clone", async () => {
    const pushed = await runCheckpoint({});
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    const tip = (await git(work)`git rev-parse HEAD`.text()).trim();

    const fresh = join(scratch, "fresh");
    await git(scratch)`git clone -q ${origin} fresh`;
    // Origin never saw `feature`: start it anywhere, as a Sandbox clone does.
    await git(fresh)`git checkout -q -b feature origin/main`;
    const restore = await git(
      fresh,
    )`bash -c ${checkpointRestoreScript(ref, commit!)}`
      .quiet()
      .nothrow();
    expect(restore.stderr.toString()).toBe("");
    expect(restore.exitCode).toBe(0);
    expect((await git(fresh)`git rev-parse HEAD`.text()).trim()).toBe(tip);
    expect((await git(fresh)`git branch --show-current`.text()).trim()).toBe(
      "feature",
    );
    expect(readFileSync(join(fresh, "README.md"), "utf-8")).toBe(
      "hello\nfeature\ndirty\n",
    );
    expect(readFileSync(join(fresh, "new.txt"), "utf-8")).toBe("untracked\n");
    const status = (await git(fresh)`git status --porcelain`.text())
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(status).toEqual([" M README.md", "?? new.txt"]);
    // The temporary local ref is gone; nothing but the working tree remains.
    expect(
      (await git(fresh)`git show-ref refs/opensession/checkpoint`.nothrow())
        .exitCode,
    ).not.toBe(0);
  });

  test("a forward-only restore refuses a checkout whose tip the checkpoint does not extend", async () => {
    const pushed = await runCheckpoint({});
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    // A checkout of the same branch with a commit of its own: reused, it
    // would lose that commit.
    const diverged = join(scratch, "diverged");
    await git(scratch)`git clone -q ${origin} diverged`;
    await git(diverged)`git checkout -q -b feature origin/main`;
    writeFileSync(join(diverged, "theirs.txt"), "kept\n");
    await git(diverged)`git add theirs.txt`;
    await git(diverged)`git commit -q -m theirs`;
    const theirTip = (await git(diverged)`git rev-parse HEAD`.text()).trim();
    const refused = await git(
      diverged,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { onlyForward: true })}`
      .quiet()
      .nothrow();
    expect(refused.exitCode).not.toBe(0);
    expect((await git(diverged)`git rev-parse HEAD`.text()).trim()).toBe(
      theirTip,
    );
    expect(readFileSync(join(diverged, "theirs.txt"), "utf-8")).toBe("kept\n");
    // The same checkout parked on an ancestor of the checkpoint is fine.
    await git(diverged)`git reset -q --hard origin/main`;
    const allowed = await git(
      diverged,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { onlyForward: true })}`
      .quiet()
      .nothrow();
    expect(allowed.stderr.toString()).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(diverged, "new.txt"), "utf-8")).toBe(
      "untracked\n",
    );
  });

  test("restore refuses a ref that is not the recorded commit", async () => {
    const other = join(scratch, "other");
    await git(scratch)`git clone -q ${origin} other`;
    await git(other)`git checkout -q -b feature origin/main`;
    const restore = await git(
      other,
    )`bash -c ${checkpointRestoreScript(ref, "0".repeat(40))}`
      .quiet()
      .nothrow();
    expect(restore.exitCode).not.toBe(0);
    expect((await git(other)`git status --porcelain`.text()).trim()).toBe("");
  });
});
