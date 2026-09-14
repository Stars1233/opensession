import { expect, test } from "bun:test";
import type { ServerResourceSample } from "../../shared/server-resources";
import {
  formatResourcePercent,
  resourceChart,
  resourcePercent,
} from "./server-resource-chart";

const sample = (at: number, cpu: number | null): ServerResourceSample => ({
  at,
  cpu,
  memory: null,
  disk: null,
});

test("charts use a fixed time and percentage scale", () => {
  const chart = resourceChart([sample(0, 0), sample(2000, 100)], "cpu");
  expect(chart.path).toBe("M97.37,29.00 L99.00,1.00");
  expect(chart.last?.x).toBe(99);
  expect(chart.last?.y).toBeCloseTo(1);
});

test("missing samples and long gaps break the line", () => {
  expect(
    resourceChart(
      [sample(0, 10), sample(2000, null), sample(4000, 20), sample(20000, 30)],
      "cpu",
    ).path.match(/M/g),
  ).toHaveLength(3);
  expect(
    resourceChart([sample(0, 10), sample(2000, null)], "cpu").last,
  ).toBeNull();
  expect(resourceChart([], "cpu")).toEqual({ path: "", last: null });
});

test("unknown readings are never shown as zero usage", () => {
  expect(formatResourcePercent(resourcePercent(undefined, "cpu"))).toBe("–");
  expect(formatResourcePercent(0)).toBe("0%");
  expect(resourcePercent(sample(0, 10), "memory")).toBeNull();
});
