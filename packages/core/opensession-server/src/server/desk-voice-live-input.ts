/** Live's response.item.create history is append-only and limited to 128
 * items / 32,768 UTF-8 bytes per session. Count the whole serialized item
 * conservatively, not JS characters. These limits are separate from the
 * backend model's token context and include typed messages as well as tools. */
export const LIVE_INPUT_MAX_ITEMS = 128;
export const LIVE_INPUT_MAX_BYTES = 32_768;
export const LIVE_TOOL_OUTPUT_MAX_BYTES = 2048;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Keep small results unchanged. Large MCP results often repeat their text
 * in structuredContent; prefer their human-readable text for the preview.
 * The complete result is mirrored to the Desk before reaching this boundary. */
export function compactLiveToolOutput(output: unknown): string {
  const serialized = JSON.stringify(output) ?? "null";
  if (byteLength(serialized) <= LIVE_TOOL_OUTPUT_MAX_BYTES) return serialized;
  let preview = serialized;
  if (
    output &&
    typeof output === "object" &&
    "content" in output &&
    Array.isArray(output.content)
  ) {
    const texts = output.content.flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    );
    if (texts.length) preview = texts.join("\n");
  }
  const encode = (length: number) =>
    JSON.stringify({
      truncated: true,
      preview: preview.slice(0, length),
      note: "Partial tool result. Full result is saved in the Desk chat. Do not repeat an action because its result was shortened.",
    });
  let low = 0;
  let high = Math.min(preview.length, LIVE_TOOL_OUTPUT_MAX_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(encode(mid)) <= LIVE_TOOL_OUTPUT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  // Do not end the preview halfway through a surrogate pair.
  const last = preview.charCodeAt(low - 1);
  if (last >= 0xd800 && last <= 0xdbff) low -= 1;
  return encode(low);
}

export type LiveBackendInputItem =
  | { type: "function_call_output"; call_id: string; output: string }
  | {
      type: "message";
      role: "user";
      content: Array<{ type: "input_text"; text: string }>;
    };

export class LiveBackendInputBudget {
  private items = 0;
  private bytes = 0;

  /** Reserve before sending. Rejected inputs consume no budget. */
  accept(item: LiveBackendInputItem): boolean {
    const bytes = byteLength(JSON.stringify(item));
    if (
      this.items >= LIVE_INPUT_MAX_ITEMS ||
      this.bytes + bytes > LIVE_INPUT_MAX_BYTES
    )
      return false;
    this.items += 1;
    this.bytes += bytes;
    return true;
  }
}
