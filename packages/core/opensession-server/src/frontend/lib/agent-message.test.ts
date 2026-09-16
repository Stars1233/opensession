import { expect, test } from "bun:test";
import { agentDeliveryStatus, outgoingAgentMessage } from "./agent-message";
import type { TranscriptEntry } from "./types";

function entry(
  toolName: string,
  toolInput: TranscriptEntry["toolInput"],
): TranscriptEntry {
  return {
    id: "send",
    type: "tool_use",
    timestamp: "",
    content: "",
    toolName,
    toolInput,
  };
}

test("reads both engine dialects and dispatched sends without losing message text", () => {
  const args = {
    id: "os-recipient",
    message: "**Ready**\n\nSecond paragraph.",
  };
  for (const name of [
    "opensession-sessions_send_to_session",
    "mcp__opensession-sessions__send_to_session",
  ]) {
    expect(outgoingAgentMessage(entry(name, args))).toEqual({
      to: args.id,
      content: args.message,
    });
    expect(
      outgoingAgentMessage(entry("mcp_call", { name, arguments: args })),
    ).toEqual({ to: args.id, content: args.message });
  }
});

test("leaves other tools and malformed or bounded payloads available as tool rows", () => {
  for (const args of [
    null,
    [],
    {},
    { id: 1, message: "Hi" },
    { id: "os-a", message: " " },
    { toolName: "send_to_session", byteSize: 50000, keys: ["id", "message"] },
  ]) {
    expect(
      outgoingAgentMessage(entry("opensession-sessions_send_to_session", args)),
    ).toBeNull();
  }
  expect(
    outgoingAgentMessage(
      entry("slack_send_to_session", { id: "channel", message: "Hi" }),
    ),
  ).toBeNull();
  expect(
    outgoingAgentMessage(
      entry("opensession-sessions_get_session", { id: "os-a" }),
    ),
  ).toBeNull();
});

test("reads delivery outcomes rather than equating tool success with delivery", () => {
  for (const [status, label] of [
    ["error", "Not sent"],
    ["queued", "Queued"],
    ["handled", "Handled"],
    ["steered", "Sent"],
    ["started", "Sent"],
  ]) {
    expect(
      agentDeliveryStatus({
        ...entry("", {}),
        type: "tool_result",
        content: `Delivery \`receipt\` status=${status}: details`,
      }),
    ).toBe(label);
  }
  expect(
    agentDeliveryStatus({
      ...entry("", {}),
      type: "tool_result",
      content: "No session with that id.",
    }),
  ).toBe("Delivery unconfirmed");
});
