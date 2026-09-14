import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./TranscriptBlocks.test-setup";

const { ClampedBody } = await import("./MessageBubble");

describe("message expander threshold", () => {
  test.each([24_000, 24_001, 29_999])(
    "shows all %i characters without an expander",
    (length) => {
      const content = `${"a".repeat(length - 9)} tail-end`;
      const html = renderToStaticMarkup(
        <ClampedBody content={content} className="" />,
      );
      expect(html).toContain(content);
      expect(html).not.toContain("Show full message");
    },
  );

  test.each([30_000, 36_000])(
    "keeps the 24,000-character preview for %i characters",
    (length) => {
      const content = `${"a".repeat(length - 9)} tail-end`;
      const html = renderToStaticMarkup(
        <ClampedBody content={content} className="" />,
      );
      expect(html).toContain("a".repeat(24_000));
      expect(html).not.toContain("tail-end");
      expect(html).toContain("Show full message");
    },
  );

  test("shows near-limit messages in full even with an earlier line break", () => {
    const content = `${"a".repeat(16_000)}\n${"b".repeat(12_000)}`;
    const html = renderToStaticMarkup(
      <ClampedBody content={content} className="" />,
    );
    expect(html).toContain("b".repeat(12_000));
    expect(html).not.toContain("Show full message");
  });

  test("keeps hydration available when only a wire preview is present", () => {
    const content = "a".repeat(24_000);
    const html = renderToStaticMarkup(
      <ClampedBody
        content={content}
        className=""
        sessionId="session"
        entry={{
          id: "entry",
          type: "assistant",
          timestamp: "2026-09-14T00:00:00.000Z",
          content,
          contentClamped: true,
          contentLength: 28_000,
        }}
      />,
    );
    expect(html).toContain("Show full message");
  });
});
