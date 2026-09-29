import { describe, expect, test } from "bun:test";
import { createSlackPostScanner } from "./slack-links";

const ok = (ts: string) =>
  `{"ok":true,"channel":"C0TEST","ts":"${ts}","message":{"text":"hi"}}`;

describe("createSlackPostScanner", () => {
  test("links a direct top-level post to its own ts", () => {
    const scan = createSlackPostScanner();
    expect(
      scan({
        type: "tool_use",
        toolUseId: "t1",
        toolName: "slack_post_message",
        toolInput: { channel_id: "C0TEST", text: "hi" },
      }),
    ).toBeUndefined();
    expect(
      scan({ type: "tool_result", toolUseId: "t1", content: ok("1.100") }),
    ).toEqual({ channel: "C0TEST", threadTs: "1.100" });
  });

  test("links a post made through the mcp_call dispatcher", () => {
    const scan = createSlackPostScanner();
    scan({
      type: "tool_use",
      toolUseId: "t2",
      toolName: "mcp_call",
      toolInput: {
        name: "slack_slack_post_message",
        arguments: { channel_id: "C0TEST", text: "hi" },
      },
    });
    expect(
      scan({ type: "tool_result", toolUseId: "t2", content: ok("2.200") }),
    ).toEqual({ channel: "C0TEST", threadTs: "2.200" });
  });

  test("a dispatched thread reply anchors to the thread it replied into", () => {
    const scan = createSlackPostScanner();
    scan({
      type: "tool_use",
      toolUseId: "t3",
      toolName: "mcp_call",
      toolInput: {
        name: "slack_slack_reply_to_thread",
        arguments: { channel_id: "C0TEST", thread_ts: "2.200", text: "hi" },
      },
    });
    expect(
      scan({ type: "tool_result", toolUseId: "t3", content: ok("3.300") }),
    ).toEqual({ channel: "C0TEST", threadTs: "2.200" });
  });

  test("ignores other dispatched tools and failed posts", () => {
    const scan = createSlackPostScanner();
    scan({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "mcp_call",
      toolInput: { name: "grafana_query_loki_logs", arguments: {} },
    });
    expect(
      scan({ type: "tool_result", toolUseId: "t4", content: ok("4.400") }),
    ).toBeUndefined();
    scan({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "mcp_call",
      toolInput: {
        name: "slack_slack_post_message",
        arguments: { channel_id: "C0TEST" },
      },
    });
    expect(
      scan({
        type: "tool_result",
        toolUseId: "t5",
        content: '{"ok":false,"error":"not_in_channel"}',
      }),
    ).toBeUndefined();
  });
});
