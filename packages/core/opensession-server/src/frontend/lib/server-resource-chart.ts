import {
  RESOURCE_HISTORY_MS,
  RESOURCE_SAMPLE_MS,
  type ServerResourceSample,
} from "../../shared/server-resources";

export type ResourceMetric = "cpu" | "memory" | "disk";
export const RESOURCE_METRICS: {
  key: ResourceMetric;
  label: string;
  shortLabel: string;
}[] = [
  { key: "cpu", label: "CPU", shortLabel: "CPU" },
  { key: "memory", label: "Memory", shortLabel: "RAM" },
  { key: "disk", label: "Disk", shortLabel: "Disk" },
];
export function resourcePercent(
  sample: ServerResourceSample | undefined,
  key: ResourceMetric,
) {
  return key === "cpu"
    ? (sample?.cpu ?? null)
    : (sample?.[key]?.usedPct ?? null);
}
export function formatResourcePercent(value: number | null) {
  return value === null ? "–" : `${Math.round(value)}%`;
}
export function formatResourceBytes(value: number) {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

/** A fixed 0–100% / two-minute scale. Missing readings and polling gaps break
 * the line rather than inventing a healthy value or interpolating an outage. */
export function resourceChart(
  samples: ServerResourceSample[],
  key: ResourceMetric,
) {
  const end = samples.at(-1)?.at ?? 0;
  let previousAt: number | null = null;
  let path = "";
  let last: { x: number; y: number } | null = null;
  for (const sample of samples) {
    const value = resourcePercent(sample, key);
    if (value === null || sample.at < end - RESOURCE_HISTORY_MS) {
      previousAt = null;
      last = null;
      continue;
    }
    const x =
      1 + ((sample.at - end + RESOURCE_HISTORY_MS) / RESOURCE_HISTORY_MS) * 98;
    const y = 29 - value * 0.28;
    const command =
      previousAt !== null && sample.at - previousAt <= RESOURCE_SAMPLE_MS * 3
        ? "L"
        : "M";
    path += `${command}${x.toFixed(2)},${y.toFixed(2)} `;
    previousAt = sample.at;
    last = { x, y };
  }
  return { path: path.trim(), last };
}
