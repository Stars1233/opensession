import { afterEach, beforeEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTurnPrefs } from "./TranscriptBlocks.test-setup";
import { sessionAgentName } from "../lib/markdown";
import { setSessionTitles, resetResolvedSessionTitles } from "../lib/markdown";
beforeEach(() => {
  setSessionTitles([
    ["os-self", "Fix upload retries"],
    ["os-peer", "Check cancellation"],
  ]);
});
afterEach(() => {
  setSessionTitles([]);
  resetResolvedSessionTitles();
});
import type { TranscriptEntry } from "../lib/types";

Object.assign(document, { querySelectorAll: () => [] });

const { MessageBubble } = await import("./MessageBubble");
const { TranscriptBlocks } = await import("./TranscriptBlocks");
const timestamp = "2026-09-14T12:00:00Z";
const incoming: TranscriptEntry = {
  id: "in",
  type: "user",
  timestamp,
  content: "[agent os-peer] <!--os:session-notice-->\n**Ready** to verify.",
};
const outgoing: TranscriptEntry = {
  id: "out",
  type: "tool_use",
  toolUseId: "send-1",
  timestamp,
  content: "",
  toolName: "mcp_call",
  toolInput: {
    name: "opensession-sessions_send_to_session",
    arguments: { id: "os-peer", message: "Please check **phone** too." },
  },
};

test("peer messages show their body and identity, never the human owner or envelope", () => {
  const html = renderToStaticMarkup(
    <MessageBubble entry={incoming} sessionId="os-self" owner="Alex" />,
  );
  expect(html).toContain(sessionAgentName("os-peer"));
  expect(html).toContain("Expand message:");
  expect(html).not.toContain("<strong>Ready</strong>");
  expect(html).toContain('data-agent-message="incoming"');
  expect(html).toContain("/session/os-peer");
  expect(html).not.toContain("Alex");
  expect(html).not.toContain("os:session-notice");
  expect(html).toContain('aria-expanded="false"');
});

test("old worker reports without an ID do not invent a sender", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{
        ...incoming,
        content: "<!--os:worker-report-->\nChecked the upload test.",
      }}
      sessionId="os-self"
    />,
  );
  expect(html).toContain("Unknown session");
  expect(html).toContain("Worker report");
  expect(html).toContain("Expand message:");
});

test("agent correspondence stays inside one collapsed work block", () => {
  setTurnPrefs("closed");
  const entries: TranscriptEntry[] = [
    {
      id: "read",
      type: "tool_use",
      toolUseId: "read-1",
      toolName: "read",
      toolInput: { path: "src/app.ts" },
      timestamp,
      content: "",
    },
    outgoing,
    {
      id: "delivery",
      type: "tool_result",
      toolUseId: "send-1",
      timestamp,
      content: "Delivery `receipt-1` status=started: Message delivered.",
    },
    incoming,
    { id: "answer", type: "assistant", timestamp, content: "All checked." },
  ];
  const html = renderToStaticMarkup(
    <TranscriptBlocks
      entries={entries}
      sessionId="os-self"
      virtualize={false}
    />,
  );
  expect(html).not.toContain('data-agent-message="outgoing"');
  expect(html).not.toContain('data-agent-message="incoming"');
  expect(html).toContain("All checked.");
  expect(html).not.toContain("src/app.ts");
  expect(new Set(html.match(/data-eid="[^"]+#turn"/g)).size).toBe(1);
  setTurnPrefs("open");
  const open = renderToStaticMarkup(
    <TranscriptBlocks
      entries={entries}
      sessionId="os-self"
      virtualize={false}
    />,
  );
  expect(open.match(/data-agent-message="outgoing"/g)).toHaveLength(1);
  expect(open.match(/data-agent-message="incoming"/g)).toHaveLength(1);
  expect(open.indexOf('data-agent-message="outgoing"')).toBeLessThan(
    open.indexOf('data-agent-message="incoming"'),
  );
  expect(open).toContain("Sent");
});

test("failed and unconfirmed sends are not presented as delivered", () => {
  const result: TranscriptEntry = {
    id: "error",
    type: "tool_result",
    toolUseId: "send-1",
    timestamp,
    content: "Session not found",
    isError: true,
  };
  const failed = renderToStaticMarkup(
    <MessageBubble entry={outgoing} toolResult={result} sessionId="os-self" />,
  );
  expect(failed).toContain("Not sent");
  const unknown = renderToStaticMarkup(
    <MessageBubble entry={outgoing} sessionId="os-self" />,
  );
  expect(unknown).toContain("Delivery unconfirmed");
});

test("ordinary replies stay uncluttered while system notices and humans stay separate", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{ id: "a", type: "assistant", timestamp, content: "Done." }}
      sessionId="os-self"
    />,
  );
  expect(html).toContain("Done.");
  expect(html).not.toContain(sessionAgentName("os-self"));
  expect(html).not.toContain("Current session");
  expect(html).not.toContain("<svg");
  const system = renderToStaticMarkup(
    <MessageBubble
      entry={{
        id: "s",
        type: "system",
        timestamp,
        content: "Run failed: timeout",
      }}
      sessionId="os-self"
    />,
  );
  expect(system).not.toContain(sessionAgentName("os-self"));
  const human = renderToStaticMarkup(
    <MessageBubble
      entry={{
        id: "u",
        type: "user",
        timestamp,
        content: "Thanks.",
        sender: "Alex",
      }}
      sessionId="os-self"
    />,
  );
  expect(human).not.toContain(sessionAgentName("os-self"));
});

test("agent headers use one corner avatar and explicit direction", () => {
  for (const entry of [incoming, outgoing]) {
    const html = renderToStaticMarkup(
      <MessageBubble entry={entry} sessionId="os-self" />,
    );
    const header = html
      .split('data-agent-message-header=""')[1]!
      .split("</div>")[0]!;
    expect(header.match(/viewBox="0 0 80 80"/g)).toHaveLength(1);
    expect(header).toContain(sessionAgentName("os-peer"));
    expect(header).toContain('data-session-id="os-peer"');
    expect(header).toContain(
      entry === outgoing ? "To agent</span>" : "From agent</span>",
    );
    if (entry === outgoing) {
      expect(header).toContain("order-last");
      expect(header).toContain(
        `aria-label="Current session: ${sessionAgentName("os-self")}"`,
      );
    } else {
      expect(header).toContain("rotate-180");
    }
    expect(html).not.toContain("Delivery details");
  }
});

test("the top bar keeps only an accessible avatar, with its name in the tooltip", async () => {
  const { SessionHeader } = await import("./session/SessionHeader");
  const html = renderToStaticMarkup(
    <SessionHeader
      session={{
        id: "os-self",
        source: "opensession",
        branch: null,
        worktreeDir: null,
        startedBy: null,
        title: "Check the retry loop",
        lastActivity: timestamp,
        createdAt: timestamp,
        isRunning: false,
      }}
      hasWorkspace={false}
      models={[]}
      archiving={false}
      onArchive={() => {}}
      renameDraft={null}
      onRenameDraftChange={() => {}}
      onCommitRename={() => {}}
      onCancelRename={() => {}}
      canRename={false}
      menu={null}
      isPhone={false}
      actions={null}
      headerRef={null}
      headerActionsRef={null}
    />,
  );
  expect(html).toContain(
    `aria-label="Current session: ${sessionAgentName("os-self")}"`,
  );
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("<svg");
  expect(html).not.toContain(`>${sessionAgentName("os-self")}</span>`);
  expect(html).not.toContain(">Current session</span>");
  expect(html).toContain("Check the retry loop");
});

test("a worker message uses its own task title", () => {
  setSessionTitles([
    ["os-self", "Parent"],
    ["os-peer", "Worker", false, null, undefined, "os-self"],
  ]);
  const html = renderToStaticMarkup(
    <MessageBubble entry={incoming} sessionId="os-self" />,
  );
  expect(html).toContain("Worker");
  expect(html).not.toContain("Emberfall");
  expect(html).toContain('data-session-id="os-peer"');
});

test("agent tooltip gives the session title secondary emphasis", async () => {
  const { AgentTooltipLabel } = await import("./AgentIdentity");
  const html = renderToStaticMarkup(
    <AgentTooltipLabel name="Fensan Emberfall" sessionTitle="Fix retries" />,
  );
  expect(html).toContain('<span class="block">Fensan Emberfall</span>');
  expect(html).toContain("text-meta font-normal text-tooltip-fg/70");
  expect(html).toContain(">Fix retries</span>");
});

test("agent correspondence uses a single-line summary but normal replies do not", () => {
  for (const entry of [
    incoming,
    outgoing,
    {
      ...incoming,
      content: "[worker os-peer] <!--os:worker-report-->\nWorker report text",
    },
  ]) {
    const html = renderToStaticMarkup(
      <MessageBubble entry={entry} sessionId="os-self" />,
    );
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain("Expand message:");
  }
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{
        id: "normal",
        type: "assistant",
        timestamp,
        content: "An ordinary reply.",
      }}
      sessionId="os-self"
    />,
  );
  expect(html).not.toContain("max-h-[3lh]");
});

test("wire-clamped agent messages keep one accessible expansion control", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{ ...incoming, contentClamped: true, contentLength: 50_000 }}
      sessionId="os-self"
    />,
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("aria-controls=");
  expect(html.match(/aria-controls=/g)).toHaveLength(1);
  expect(html).not.toContain("Show full message");
});

test("a failed outgoing send retains its delivery state inside the work block", () => {
  setTurnPrefs("open");
  const html = renderToStaticMarkup(
    <TranscriptBlocks
      entries={[
        outgoing,
        {
          id: "failed-send",
          type: "tool_result",
          toolUseId: "send-1",
          timestamp,
          content: "Delivery failed",
          isError: true,
        },
        {
          id: "final",
          type: "assistant",
          timestamp,
          content: "Could not deliver.",
        },
      ]}
      sessionId="os-self"
      virtualize={false}
    />,
  );
  expect(html).toContain("Not sent");
  expect(html).toContain("Could not deliver.");
  expect(html).toContain('data-agent-message="outgoing"');
});

test("agent chat bubbles share user-message sizing but keep their provenance clear", () => {
  const received = renderToStaticMarkup(
    <MessageBubble entry={incoming} sessionId="os-self" />,
  );
  const sent = renderToStaticMarkup(
    <MessageBubble entry={outgoing} sessionId="os-self" />,
  );
  expect(received).toContain('aria-label="Incoming agent message"');
  expect(sent).toContain('aria-label="Outgoing agent message"');
  expect(received).toContain("self-start");
  expect(sent).toContain("self-end");
  for (const html of [received, sent]) {
    expect(html).toContain("w-fit");
    expect(html).toContain("max-w-[min(600px,90%)]");
    expect(html).toContain("size-4.5");
  }
});

test("summary hover follows the bubble instead of an inset button", () => {
  const html = renderToStaticMarkup(
    <MessageBubble entry={outgoing} sessionId="os-self" />,
  );
  expect(html).toContain("rounded-xl p-0");
  expect(html).toContain("rounded-[inherit]");
  expect(html).toContain("active:scale-100");
  expect(html).toContain("phone:min-h-12");
});

test("delivery marks distinguish queue, send, handling, failure and missing evidence", async () => {
  const { AgentDeliveryMark } = await import("./AgentDeliveryMark");
  for (const [status, label, checks] of [
    ["queued", "Queued", 0],
    ["started", "Sent", 1],
    ["steered", "Sent", 1],
    ["handled", "Handled", 2],
    ["error", "Not sent", 0],
    ["unknown", "Delivery unconfirmed", 0],
  ] as const) {
    const html = renderToStaticMarkup(
      <AgentDeliveryMark
        result={{
          id: "receipt",
          type: "tool_result",
          timestamp,
          content: `Delivery status=${status}: Result`,
        }}
      />,
    );
    expect(html).toContain(`aria-label="${label}"`);
    expect(html.match(/M5.75 12.75L9.5 16.25L18.25 7.75/g) ?? []).toHaveLength(
      checks,
    );
    expect(html).not.toContain("Read");
  }
});
