import { describe, expect, test } from "bun:test";
import { serverResourcesSchema } from "../shared/server-resources";
import {
  cpuUsage,
  makeServerResourceSampler,
  parseCpuTimes,
  parseMemory,
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
  test("reads the real host using the bounded async sampler", async () => {
    const result = await makeServerResourceSampler()();
    expect(serverResourcesSchema.safeParse(result).success).toBe(true);
    expect(result.samples[0].memory?.totalBytes).toBeGreaterThan(0);
    expect(result.samples[0].disk?.totalBytes).toBeGreaterThan(0);
  });
});
