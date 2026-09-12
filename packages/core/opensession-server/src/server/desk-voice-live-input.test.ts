import { describe, expect, test } from "bun:test";
import {
  LIVE_INPUT_MAX_BYTES,
  LIVE_INPUT_MAX_ITEMS,
  LIVE_TOOL_OUTPUT_MAX_BYTES,
  LiveBackendInputBudget,
  compactLiveToolOutput,
} from "./desk-voice-live-input";

const textItem = (text: string) => ({
  type: "message" as const,
  role: "user" as const,
  content: [{ type: "input_text" as const, text }],
});

describe("Live tool output compaction", () => {
  test("keeps small outputs unchanged", () => {
    expect(compactLiveToolOutput({ ok: true, id: "os-test" })).toBe(
      '{"ok":true,"id":"os-test"}',
    );
    expect(compactLiveToolOutput(undefined)).toBe("null");
  });

  test.each(["check passed\n", "😀 漢字 ", '\\"\n\t'])(
    "bounds valid JSON by UTF-8 bytes including escaping: %j",
    (fragment) => {
      const result = compactLiveToolOutput({ text: fragment.repeat(8000) });
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(
        LIVE_TOOL_OUTPUT_MAX_BYTES,
      );
      const parsed = JSON.parse(result);
      expect(parsed.truncated).toBe(true);
      expect(parsed.preview.length).toBeGreaterThan(0);
      expect(parsed.preview.isWellFormed()).toBe(true);
      expect(parsed.note).toContain("Do not repeat an action");
    },
  );

  test("uses MCP text rather than duplicating a large structured result", () => {
    const output = {
      content: [
        {
          type: "text",
          text:
            "PR 42 is not ready: one check failed.\n" +
            "✓ passing check\n".repeat(1000),
        },
      ],
      structuredContent: {
        checks: Array.from({ length: 1000 }, () => ({
          name: "passing check",
          status: "pass",
        })),
      },
    };
    const original = JSON.stringify(output);
    const compact = JSON.parse(compactLiveToolOutput(output));
    expect(compact.preview).toStartWith(
      "PR 42 is not ready: one check failed.",
    );
    expect(compact.truncated).toBe(true);
    expect(JSON.stringify(output)).toBe(original);
  });
});

describe("Live backend input budget", () => {
  test("counts UTF-8 bytes of the complete serialized item and admits the exact limit", () => {
    const budget = new LiveBackendInputBudget();
    const overhead = Buffer.byteLength(JSON.stringify(textItem("")));
    const item = textItem(
      "😀".repeat(Math.floor((LIVE_INPUT_MAX_BYTES - overhead) / 4)),
    );
    const remainder =
      LIVE_INPUT_MAX_BYTES - Buffer.byteLength(JSON.stringify(item));
    item.content[0].text += "x".repeat(remainder);
    expect(Buffer.byteLength(JSON.stringify(item))).toBe(LIVE_INPUT_MAX_BYTES);
    expect(budget.accept(item)).toBe(true);
    expect(budget.accept(textItem(""))).toBe(false);
  });

  test("counts items as well as bytes", () => {
    const budget = new LiveBackendInputBudget();
    for (let i = 0; i < LIVE_INPUT_MAX_ITEMS; i++)
      expect(budget.accept(textItem(""))).toBe(true);
    expect(budget.accept(textItem(""))).toBe(false);
  });

  test("rejected typed text does not consume the remaining budget", () => {
    const budget = new LiveBackendInputBudget();
    expect(budget.accept(textItem("x".repeat(LIVE_INPUT_MAX_BYTES)))).toBe(
      false,
    );
    expect(budget.accept(textItem("retry a shorter message"))).toBe(true);
  });
});
