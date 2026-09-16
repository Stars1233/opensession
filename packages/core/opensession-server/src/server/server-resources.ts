import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import {
  RESOURCE_HISTORY_MS,
  RESOURCE_SAMPLE_MS,
  type ServerResourceSample,
  type ServerResources,
} from "../shared/server-resources";

type CpuTimes = { idle: number; total: number };

export function parseCpuTimes(text: string): CpuTimes {
  const line = text.split("\n", 1)[0];
  if (!line.startsWith("cpu ")) throw new Error("Missing aggregate CPU times");
  // guest and guest_nice are already included in user and nice.
  const times = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (times.length < 4 || times.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("Invalid CPU times");
  }
  return {
    idle: times[3] + (times[4] ?? 0),
    total: times.reduce((sum, value) => sum + value, 0),
  };
}

export function cpuUsage(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return ((total - idle) / total) * 100;
}

export function resourceCapacity(totalBytes: number, availableBytes: number) {
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(availableBytes) ||
    availableBytes < 0
  ) {
    throw new Error("Invalid resource capacity");
  }
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { totalBytes, usedBytes, usedPct: (usedBytes / totalBytes) * 100 };
}

export function parseMemory(text: string) {
  const total = text.match(/^MemTotal:\s+(\d+) kB$/m);
  const available = text.match(/^MemAvailable:\s+(\d+) kB$/m);
  if (!total || !available) throw new Error("Missing memory capacity");
  return resourceCapacity(Number(total[1]) * 1024, Number(available[1]) * 1024);
}

/** Activity Monitor's Memory Used: app (non-purgeable anonymous), wired and
 * physically occupied compressor pages. File cache is reclaimable, not used. */
export function parseMacMemory(text: string, totalBytes: number) {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0)
    throw new Error("Invalid memory page size");
  const pages = (name: string) => {
    const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\.$`, "m"));
    const value = Number(match?.[1]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid memory counter: ${name}`);
    return value;
  };
  const usedBytes =
    (pages("Anonymous pages") -
      pages("Pages purgeable") +
      pages("Pages wired down") +
      pages("Pages occupied by compressor")) *
    pageSize;
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0)
    throw new Error("Invalid used memory");
  return resourceCapacity(totalBytes, totalBytes - usedBytes);
}

async function readCpuTimes(): Promise<CpuTimes> {
  if (process.platform === "linux")
    return parseCpuTimes(await readFile("/proc/stat", "utf8"));
  return cpus().reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total:
        sum.total +
        times.user +
        times.nice +
        times.sys +
        times.idle +
        times.irq,
    }),
    { idle: 0, total: 0 },
  );
}

async function readMemory() {
  if (process.platform === "linux")
    return parseMemory(await readFile("/proc/meminfo", "utf8"));
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["/usr/bin/vm_stat"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1_000,
    });
    const [text, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error("Unable to read macOS memory counters");
    return parseMacMemory(text, totalmem());
  }
  return resourceCapacity(totalmem(), freemem());
}

async function readDisk() {
  const disk = await statfs(
    process.platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : "/",
  );
  return resourceCapacity(disk.blocks * disk.bsize, disk.bavail * disk.bsize);
}

/** Demand-sampled, single-flight and bounded across all viewers. No fleet scans,
 * synchronous I/O, or import-time timers. macOS uses a time-bounded async vm_stat. */
export function makeServerResourceSampler({
  now = Date.now,
  cpu = readCpuTimes,
  memory = readMemory,
  disk = readDisk,
}: {
  now?: () => number;
  cpu?: () => Promise<CpuTimes>;
  memory?: () => Promise<NonNullable<ServerResourceSample["memory"]>>;
  disk?: () => Promise<NonNullable<ServerResourceSample["disk"]>>;
} = {}) {
  let samples: ServerResourceSample[] = [];
  let previous: { at: number; times: CpuTimes } | null = null;
  let pending: Promise<ServerResources> | null = null;
  return function snapshot(): Promise<ServerResources> {
    if (pending) return pending;
    const latest = samples.at(-1);
    if (latest && now() - latest.at < RESOURCE_SAMPLE_MS)
      return Promise.resolve({ samples });
    pending = Promise.all([
      cpu().catch(() => null),
      memory().catch(() => null),
      disk().catch(() => null),
    ])
      .then(([times, memory, disk]) => {
        const at = now();
        const cpu =
          times && previous && at - previous.at <= RESOURCE_SAMPLE_MS * 3
            ? cpuUsage(previous.times, times)
            : null;
        previous = times ? { at, times } : null;
        samples = [
          ...samples.filter((sample) => sample.at > at - RESOURCE_HISTORY_MS),
          { at, cpu, memory, disk },
        ].slice(-60);
        return { samples };
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export const serverResourceSnapshot = makeServerResourceSampler();
