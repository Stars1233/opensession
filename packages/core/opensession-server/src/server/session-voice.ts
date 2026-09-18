/** A transcript-aware voice companion. Its sole tool proposes a request for
 * human approval in the browser; this transport never executes agent work. */
import { requireVoiceApiKey } from "./desk-voice";
import {
  SESSION_VOICE_AGENT_TOOL,
  sessionVoiceInstructions,
} from "../shared/session-voice";

export function sessionVoiceConfig(context: string) {
  return {
    type: "realtime",
    model: "gpt-realtime",
    instructions: sessionVoiceInstructions(context),
    tools: [
      {
        type: "function",
        name: SESSION_VOICE_AGENT_TOOL,
        description:
          "Propose new investigation or work by the session agent only when the transcript cannot answer. This opens a human approval card and may take minutes after approval. It does not start work by itself.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "The exact, self-contained question or task to send to the existing session agent.",
            },
            reason: {
              type: "string",
              description:
                "Why this needs new agent work rather than an answer from the thread.",
            },
          },
          required: ["prompt", "reason"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: "auto",
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          // Answer in the voice conversation, never as an agent prompt.
          create_response: true,
          interrupt_response: true,
        },
        noise_reduction: { type: "near_field" },
      },
      output: { voice: "marin" },
    },
  };
}

export async function createSessionVoiceAnswer(
  sdp: string,
  signal: AbortSignal,
  context: string,
): Promise<string> {
  const key = await requireVoiceApiKey();
  const body = new FormData();
  body.set("sdp", sdp);
  body.set("session", JSON.stringify(sessionVoiceConfig(context)));
  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    // Do not echo provider bodies or credentials into the browser or logs.
    await response.body?.cancel();
    throw new Error(
      `OpenAI could not start the voice call (HTTP ${response.status}).`,
    );
  }
  return response.text();
}
