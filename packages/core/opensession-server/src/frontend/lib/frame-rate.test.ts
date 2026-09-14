import { expect, test } from "bun:test";
import { createFrameRateMeter } from "./frame-rate";

test("publishes once per second, not once per frame", () => {
  const meter = createFrameRateMeter();
  expect(meter.frame(0)).toBeNull();
  for (let i = 1; i < 60; i++) expect(meter.frame((i * 1_000) / 60)).toBeNull();
  expect(meter.frame(1_000)).toBe(60);
  expect(meter.frame(1_010)).toBeNull();
});

test("measures high refresh displays without clamping to 60 FPS", () => {
  const meter = createFrameRateMeter();
  meter.frame(0);
  for (let i = 1; i < 144; i++) meter.frame((i * 1_000) / 144);
  expect(meter.frame(1_000)).toBe(144);
});

test("includes long frames in the measurement instead of hiding stalls", () => {
  const meter = createFrameRateMeter();
  meter.frame(0);
  for (let i = 1; i <= 30; i++) meter.frame((i * 1_000) / 60);
  expect(meter.frame(1_500)).toBe(21);
});

test("resuming a hidden tab starts a fresh measurement window", () => {
  const meter = createFrameRateMeter();
  meter.frame(0);
  meter.frame(500);
  meter.reset();
  expect(meter.frame(120_000)).toBeNull();
  expect(meter.frame(120_500)).toBeNull();
  expect(meter.frame(121_000)).toBe(2);
});
