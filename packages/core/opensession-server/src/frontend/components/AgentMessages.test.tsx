import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTurnPrefs } from "./TranscriptBlocks.test-setup";
import { agentIdentity } from "../lib/agent-identity";
import { setSessionTitles, resetResolvedSessionTitles } from "../lib/markdown";
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

test("ordinary replies stay uncluttered while system notices and humans stay separate", () => {
  const html = renderToStaticMarkup(
    <MessageBubble
      entry={{ id: "a", type: "assistant", timestamp, content: "Done." }}
      sessionId="os-self"
    />,
  );
  expect(html).toContain("Done.");
  expect(html).not.toContain(agentIdentity("os-self").name);
  expect(html).not.toContain("Current agent");
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

test("identifies the local agent and keeps sender and recipient in one header", () => {
  for (const entry of [incoming, outgoing]) {
    const html = renderToStaticMarkup(
      <MessageBubble entry={entry} sessionId="os-self" />,
    );
    const header = html
      .split('data-agent-message-header=""')[1]!
      .split("</div>")[0]!;
    expect(header).toContain(agentIdentity("os-self").name);
    expect(header).toContain(agentIdentity("os-peer").name);
    expect(header).toContain(
      `aria-label="Current agent: ${agentIdentity("os-self").name}"`,
    );
    expect(header).not.toContain(">Current agent</span>");
    expect(header).toContain('sr-only">to</span>');
    expect(header).not.toContain('data-session-id="os-self"');
    expect(header).toContain('data-session-id="os-peer"');
    const from = entry === incoming ? "os-peer" : "os-self";
    const to = entry === incoming ? "os-self" : "os-peer";
    expect(header.indexOf(agentIdentity(from).name)).toBeLessThan(
      header.indexOf(agentIdentity(to).name),
    );
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
    `aria-label="Current agent: ${agentIdentity("os-self").name}"`,
  );
  expect(html).toContain('tabindex="0"');
  expect(html).toContain("<svg");
  expect(html).not.toContain(`>${agentIdentity("os-self").name}</span>`);
  expect(html).not.toContain(">Current agent</span>");
  expect(html).toContain("Check the retry loop");
});

test("a worker message uses its family surname, not its independent surname", () => {
  setSessionTitles([
    ["os-self", "Parent"],
    ["os-peer", "Worker", false, null, undefined, "os-self"],
  ]);
  const html = renderToStaticMarkup(
    <MessageBubble entry={incoming} sessionId="os-self" />,
  );
  expect(html).toContain(agentIdentity("os-peer", "os-self").name);
  expect(html).not.toContain(agentIdentity("os-peer").name);
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

test("agent correspondence uses a three-line preview but normal replies do not", () => {
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
    expect(html).toContain("max-h-[3lh] overflow-hidden");
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
  expect(html.match(/>Show more</g)).toHaveLength(1);
  expect(html).not.toContain("Show full message");
});
