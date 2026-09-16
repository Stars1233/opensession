import { describe, expect, test } from "bun:test";
import { serverResourcesSchema } from "../shared/server-resources";
import {
  cpuUsage,
  makeServerResourceSampler,
  parseCpuTimes,
  parseMemory,
  parseMacMemory,
  resourceCapacity,
} from "./server-resources";

describe("server resource metrics", () => {
  test("CPU excludes guest double-counting and treats iowait as idle", () => {
    const previous = parseCpuTimes(
      "cpu  100 0 20 500 50 0 0 0 40 0\ncpu0 1 2 3 4\n",
    );
    expect(previous).toEqual({ idle: 550, total: 670 });
    expect(cpuUsage(previous, { idle: 600, total: 770 })).toBe(50);
    expect(cpuUsage(previous, previous)).toBeNull();
    expect(cpuUsage(previous, { idle: 0, total: 10 })).toBeNull();
    expect(() => parseCpuTimes("cpu0 1 2 3 4")).toThrow();
  });
  test("memory uses available, not free, to account for reclaimable cache", () => {
    expect(
      parseMemory("MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 400 kB\n"),
    ).toEqual({ totalBytes: 1024000, usedBytes: 614400, usedPct: 60 });
    expect(() => parseMemory("MemTotal: 0 kB\n")).toThrow();
    expect(resourceCapacity(1000, 100)).toEqual({
      totalBytes: 1000,
      usedBytes: 900,
      usedPct: 90,
    });
  });
  const macMemory = (
    pageSize: number,
  ) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free:                                     10.
Pages active:                                  400.
Pages inactive:                                200.
Pages speculative:                              50.
Pages wired down:                              100.
Pages purgeable:                                50.
File-backed pages:                             250.
Anonymous pages:                               400.
Pages stored in compressor:                    600.
Pages occupied by compressor:                  200.
`;
  test.each([4096, 16384])(
    "macOS uses app, wired and physical compressed memory with %i-byte pages",
    (pageSize) => {
      expect(parseMacMemory(macMemory(pageSize), 1000 * pageSize)).toEqual({
        totalBytes: 1000 * pageSize,
        usedBytes: 650 * pageSize,
        usedPct: 65,
      });
      // Free, cached and uncompressed logical compressor pages do not count.
      const changedCache = macMemory(pageSize)
        .replace("10.", "1.")
        .replace("250.", "300.")
        .replace("600.", "900.");
      expect(parseMacMemory(changedCache, 1000 * pageSize).usedPct).toBe(65);
    },
  );
  test("macOS rejects missing, malformed or impossible memory counters", () => {
    const text = macMemory(16384);
    for (const invalid of [
      "",
      macMemory(0),
      text.replace("Anonymous pages:", "Missing pages:"),
      text.replace("Pages purgeable:", "Missing purgeable:"),
      text.replace("Pages wired down:", "Missing wired:"),
      text.replace("Pages occupied by compressor:", "Missing compressor:"),
      text.replace(/Anonymous pages:\s+400\./, "Anonymous pages: -400."),
      text.replace(/Anonymous pages:\s+400\./, "Anonymous pages: unknown."),
      text.replace("50.\nFile-backed", "10000.\nFile-backed"),
    ]) {
      expect(() => parseMacMemory(invalid, 1000 * 16384)).toThrow();
    }
    expect(() => parseMacMemory(text, 100 * 16384)).toThrow();
    expect(() => parseMacMemory(text, 0)).toThrow();
  });
  test("shares concurrent requests, caps history and resets CPU after gaps", async () => {
    let at = 0;
    let calls = 0;
    const snapshot = makeServerResourceSampler({
      now: () => at,
      cpu: async () => {
        calls++;
        return { idle: calls * 50, total: calls * 100 };
      },
      memory: async () => resourceCapacity(1000, 400),
      disk: async () => resourceCapacity(2000, 200),
    });
    const [first, same] = await Promise.all([snapshot(), snapshot()]);
    expect(first).toBe(same);
    expect(calls).toBe(1);
    expect(first.samples[0].cpu).toBeNull();
    await snapshot();
    expect(calls).toBe(1);
    for (let i = 0; i < 65; i++) {
      at += 2000;
      await snapshot();
    }
    const result = await snapshot();
    expect(result.samples).toHaveLength(60);
    expect(result.samples.at(-1)?.cpu).toBe(50);
    expect(serverResourcesSchema.safeParse(result).success).toBe(true);
    at += 130000;
    const afterGap = await snapshot();
    expect(afterGap.samples).toHaveLength(1);
    expect(afterGap.samples[0].cpu).toBeNull();
  });
  test("one unavailable metric does not hide the others and is retried", async () => {
    let at = 0;
    let fail = true;
    const snapshot = makeServerResourceSampler({
      now: () => at,
      cpu: async () => {
        throw new Error("not supported");
      },
      memory: async () => resourceCapacity(1000, 400),
      disk: async () => {
        if (fail) throw new Error("offline");
        return resourceCapacity(1000, 100);
      },
    });
    expect((await snapshot()).samples[0]).toMatchObject({
      cpu: null,
      disk: null,
      memory: { usedPct: 60 },
    });
    fail = false;
    at += 2000;
    expect((await snapshot()).samples.at(-1)?.disk?.usedPct).toBe(90);
  });
  test("failed memory reads leave a gap and recover on the next sample", async () => {
    let at = 0;
    const snapshot = makeServerResourceSampler({
      now: () => at,
      cpu: async () => ({ idle: at / 2, total: at }),
      memory: async () =>
        parseMacMemory(at ? macMemory(16384) : "", 1000 * 16384),
      disk: async () => resourceCapacity(1000, 100),
    });
    expect((await snapshot()).samples[0]).toMatchObject({
      memory: null,
      disk: { usedPct: 90 },
    });
    at += 2000;
    expect((await snapshot()).samples.at(-1)).toMatchObject({
      cpu: 50,
      memory: { usedPct: 65 },
    });
  });
  test("reads the real host using the bounded async sampler", async () => {
    const result = await makeServerResourceSampler()();
    expect(serverResourcesSchema.safeParse(result).success).toBe(true);
    expect(result.samples[0].memory?.totalBytes).toBeGreaterThan(0);
    expect(result.samples[0].disk?.totalBytes).toBeGreaterThan(0);
  });
});
