import useSWR from "swr";
import { z } from "zod";
import { apiSWRKey } from "../lib/api-swr";
import { request } from "../lib/api/request";

const responseSchema = z.object({
  summary: z.string().nullable(),
  partial: z.boolean().optional(),
});

/** Mounted only inside the opened work block; SWR shares repeated views. */
export function useAgentMessageSummary(
  sessionId: string | undefined,
  entryId: string,
  content: string,
) {
  const { data, isLoading } = useSWR(
    sessionId
      ? [
          ...apiSWRKey.session(sessionId),
          "agent-message-summary",
          entryId,
          content,
        ]
      : null,
    async () =>
      responseSchema.parse(
        await request<unknown>(
          `/sessions/${encodeURIComponent(sessionId!)}/entry/${encodeURIComponent(entryId)}/summary`,
          { method: "POST" },
        ),
      ),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30_000,
      shouldRetryOnError: false,
    },
  );
  if (isLoading)
    return { text: "Summarizing message…", label: "Message summary" };
  if (data?.summary)
    return {
      text: data.summary,
      label: data.partial ? "AI summary (long message excerpt)" : "AI summary",
    };
  return {
    text: content.replace(/\s+/g, " ").trim().slice(0, 240) || "Agent message",
    label: "Message preview (summary unavailable)",
  };
}
