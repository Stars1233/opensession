import {
  parseMcpTool,
  unwrapMcpDispatcher,
} from "@tellahq/opensession-protocol/tool-presentation";
import type { TranscriptEntry } from "./types";
import { z } from "zod";

const sendInput = z.object({
  id: z.string().min(1),
  message: z.string().refine((text) => text.trim().length > 0),
});

/** Only known session-send calls are conversation. Malformed/bounded inputs
 * remain tool rows so their original detail disclosure is still available. */
export function outgoingAgentMessage(
  entry: TranscriptEntry,
): { to: string; content: string } | null {
  if (entry.type !== "tool_use") return null;
  const call = unwrapMcpDispatcher(entry.toolName ?? "", entry.toolInput);
  const tool = parseMcpTool(call.toolName);
  if (
    tool?.server !== "opensession-sessions" ||
    tool.tool !== "send_to_session"
  )
    return null;
  const parsed = sendInput.safeParse(call.input);
  return parsed.success
    ? { to: parsed.data.id, content: parsed.data.message }
    : null;
}

/** A successful MCP invocation can still report a refused delivery. */
export function agentDeliveryStatus(result?: TranscriptEntry): string {
  if (!result) return "Delivery unconfirmed";
  if (result.isError) return "Not sent";
  const status = result.content.match(
    /\bstatus=(steered|queued|started|handled|error):/,
  )?.[1];
  if (status === "error") return "Not sent";
  if (status === "queued") return "Queued";
  if (status === "handled") return "Handled";
  if (status === "steered" || status === "started") return "Sent";
  // Old servers returned free-form text. Don't invent delivery evidence.
  return "Delivery unconfirmed";
}
