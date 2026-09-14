import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFileAtomic,
  writeFileAtomicAsync,
  writeJsonAtomic,
  writeJsonAtomicAsync,
} from "./atomic-write";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes the exact content to the target path", () => {
    const path = join(dir, "plain.txt");
    writeFileAtomic(path, "hello atomic world\n");
    expect(readFileSync(path, "utf-8")).toBe("hello atomic world\n");
  });

  it("replaces an existing file's content", () => {
    const path = join(dir, "replace.txt");
    writeFileSync(path, "old content");
    writeFileAtomic(path, "new content");
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });

  it("leaves no .tmp files behind", () => {
    const sub = join(dir, "tmp-check");
    writeFileAtomic(join(sub, "a.txt"), "one");
    writeFileAtomic(join(sub, "a.txt"), "two");
    writeFileAtomic(join(sub, "b.txt"), "three");
    const leftovers = readdirSync(sub).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readdirSync(sub).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("creates missing parent directories", () => {
    const path = join(dir, "deep", "nested", "dirs", "file.txt");
    expect(existsSync(join(dir, "deep"))).toBe(false);
    writeFileAtomic(path, "made it");
    expect(readFileSync(path, "utf-8")).toBe("made it");
  });

  it("handles empty content", () => {
    const path = join(dir, "empty.txt");
    writeFileAtomic(path, "");
    expect(readFileSync(path, "utf-8")).toBe("");
  });
});

describe("writeJsonAtomic", () => {
  it("writes pretty-printed JSON by default that round-trips", () => {
    const path = join(dir, "pretty.json");
    const value = {
      name: "opensession",
      nested: { list: [1, 2, 3], ok: true },
    };
    writeJsonAtomic(path, value);
    const raw = readFileSync(path, "utf-8");
    expect(JSON.parse(raw)).toEqual(value);
    expect(raw).toContain("\n"); // pretty = multi-line
  });

  it("writes compact JSON when pretty=false", () => {
    const path = join(dir, "compact.json");
    const value = { a: 1, b: [true, null] };
    writeJsonAtomic(path, value, false);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toBe(JSON.stringify(value));
    expect(JSON.parse(raw)).toEqual(value);
  });

  it("replaces an existing JSON file whole (no torn merge)", () => {
    const path = join(dir, "state.json");
    writeJsonAtomic(path, { generation: 1, items: ["a", "b"] });
    writeJsonAtomic(path, { generation: 2 });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ generation: 2 });
  });
});

describe("writeFileAtomicAsync", () => {
  it("writes, replaces and creates parents like the sync helper", async () => {
    const sub = join(dir, "async", "nested");
    const path = join(sub, "a.txt");
    expect(existsSync(join(dir, "async"))).toBe(false);
    await writeFileAtomicAsync(path, "one");
    expect(readFileSync(path, "utf-8")).toBe("one");
    await writeFileAtomicAsync(path, "two");
    expect(readFileSync(path, "utf-8")).toBe("two");
    await writeFileAtomicAsync(join(sub, "empty.txt"), "");
    expect(readFileSync(join(sub, "empty.txt"), "utf-8")).toBe("");
    expect(readdirSync(sub).sort()).toEqual(["a.txt", "empty.txt"]);
  });

  it("applies the requested mode to the replaced file", async () => {
    const path = join(dir, "secret.txt");
    await writeFileAtomicAsync(path, "token", 0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("concurrent writers each land whole and leave no temp files", async () => {
    const path = join(dir, "race.txt");
    const payloads = Array.from({ length: 8 }, (_, i) =>
      `payload-${i}`.repeat(64),
    );
    await Promise.all(payloads.map((p) => writeFileAtomicAsync(path, p)));
    expect(payloads).toContain(readFileSync(path, "utf-8"));
    expect(
      readdirSync(dir).filter((f) => f.startsWith("race.txt.tmp.")),
    ).toEqual([]);
  });

  it("removes its temp file when the rename fails", async () => {
    const sub = join(dir, "rename-fails");
    mkdirSync(join(sub, "target"), { recursive: true });
    // Renaming a file over a directory is refused, after the temp file was
    // fully written: the failure path has to clean that file up.
    await expect(
      writeFileAtomicAsync(join(sub, "target"), "content"),
    ).rejects.toThrow();
    expect(readdirSync(sub)).toEqual(["target"]);
    expect(statSync(join(sub, "target")).isDirectory()).toBe(true);
  });
});

describe("writeJsonAtomicAsync", () => {
  it("round-trips pretty and compact JSON", async () => {
    const pretty = join(dir, "async-pretty.json");
    const value = { name: "opensession", nested: { list: [1, 2, 3] } };
    await writeJsonAtomicAsync(pretty, value);
    const raw = readFileSync(pretty, "utf-8");
    expect(JSON.parse(raw)).toEqual(value);
    expect(raw).toContain("\n");
    const compact = join(dir, "async-compact.json");
    await writeJsonAtomicAsync(compact, value, false);
    expect(readFileSync(compact, "utf-8")).toBe(JSON.stringify(value));
  });
});
