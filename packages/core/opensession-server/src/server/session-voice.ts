/** A transcript-aware voice companion. Its sole tool requests tool-less
 * reasoning help, or proposes agent work for spoken human approval in the
 * browser; this transport never executes agent work. */
import { requireVoiceApiKey } from "./desk-voice";
import {
  SESSION_VOICE_HELP_TOOL,
  SESSION_VOICE_TARGETS,
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
        name: SESSION_VOICE_HELP_TOOL,
        description:
          "Consult a tool-less reasoning helper about the transcript (no permission needed), or propose new repository work by the session agent, which the voice layer first asks permission for aloud.",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: [...SESSION_VOICE_TARGETS],
              description:
                "Choose by difficulty: luna for quick transcript reasoning, terra for deeper reasoning, conversation for the hardest questions on the thread's own main model. Only session_agent can investigate or change repository state or post to the thread.",
            },
            prompt: {
              type: "string",
              description:
                "The exact, self-contained question or task. Include relevant context from the spoken conversation.",
            },
            reason: {
              type: "string",
              description: "Why help is needed rather than answering directly.",
            },
          },
          required: ["target", "prompt", "reason"],
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
          // High eagerness ends the user's turn soon after they stop speaking
          // so replies start sooner. Desk voice keeps its own preset.
          eagerness: "high",
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
