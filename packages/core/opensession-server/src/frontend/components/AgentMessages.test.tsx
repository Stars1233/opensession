import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTurnPrefs } from "./TranscriptBlocks.test-setup";
import { agentIdentity } from "../lib/agent-identity";
import type { TranscriptEntry } from "../lib/types";

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
  expect(html).toContain(agentIdentity("os-peer").name);
  expect(html).toContain("<strong>Ready</strong>");
  expect(html).toContain('data-agent-message="incoming"');
  expect(html).toContain("/session/os-peer");
  expect(html).not.toContain("Alex");
  expect(html).not.toContain("os:session-notice");
  expect(html).not.toContain("aria-expanded");
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
  expect(html).toContain("Unknown agent");
  expect(html).toContain("Worker report");
  expect(html).toContain("Checked the upload test.");
});

test("outgoing messages remain in order and visible when work is collapsed", () => {
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
  expect(html).toContain("Please check <strong>phone</strong> too.");
  expect(html).toContain(">Sent</span>");
  expect(html).toContain(agentIdentity("os-self").name);
  expect(html.match(/data-agent-message="outgoing"/g)).toHaveLength(1);
  expect(html.indexOf("Please check")).toBeLessThan(html.indexOf("Ready"));
  expect(html.indexOf("Ready")).toBeLessThan(html.indexOf("All checked."));
  expect(html).not.toContain("src/app.ts");
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

test("ordinary replies use the same identity but system notices and humans stay separate", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{ id: "a", type: "assistant", timestamp, content: "Done." }}
      sessionId="os-self"
    />,
  );
  expect(html).toContain(agentIdentity("os-self").name);
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
  expect(system).not.toContain(agentIdentity("os-self").name);
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
  expect(human).not.toContain(agentIdentity("os-self").name);
});
