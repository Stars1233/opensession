import { describe, expect, test } from "bun:test";
import {
  WEBHOOK_MAX_CONCURRENT_LIMIT,
  sanitizeWebhookMaxConcurrent,
  webhookAtCapacity,
} from "./automations";

describe("sanitizeWebhookMaxConcurrent", () => {
  test("unset and the default of 1 both store as unset", () => {
    expect(sanitizeWebhookMaxConcurrent(undefined)).toBeUndefined();
    expect(sanitizeWebhookMaxConcurrent(null)).toBeUndefined();
    expect(sanitizeWebhookMaxConcurrent(1)).toBeUndefined();
  });

  test("keeps integers up to the limit", () => {
    expect(sanitizeWebhookMaxConcurrent(2)).toBe(2);
    expect(sanitizeWebhookMaxConcurrent(WEBHOOK_MAX_CONCURRENT_LIMIT)).toBe(
      WEBHOOK_MAX_CONCURRENT_LIMIT,
    );
  });

  test("rejects values outside the range or of the wrong type", () => {
    for (const bad of [0, -1, 1.5, WEBHOOK_MAX_CONCURRENT_LIMIT + 1, "3"]) {
      expect(sanitizeWebhookMaxConcurrent(bad)).toEqual({
        error: `webhookMaxConcurrent must be an integer from 1 to ${WEBHOOK_MAX_CONCURRENT_LIMIT}`,
      });
    }
  });
});

describe("webhookAtCapacity", () => {
  test("defaults to one run at a time", () => {
    expect(webhookAtCapacity({ id: "a" }, 0)).toBe(false);
    expect(webhookAtCapacity({ id: "a" }, 1)).toBe(true);
  });

  test("allows overlap up to the configured cap", () => {
    const automation = { id: "a", webhookMaxConcurrent: 3 };
    expect(webhookAtCapacity(automation, 2)).toBe(false);
    expect(webhookAtCapacity(automation, 3)).toBe(true);
  });
});
