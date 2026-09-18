import { afterEach, expect, spyOn, test } from "bun:test";
import { sessionVoiceConfig, createSessionVoiceAnswer } from "./session-voice";
import { handleSessionVoiceRoutes } from "./routes/session-voice";
import * as voice from "./desk-voice";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

test("voice answers from thread context and can only propose agent work", () => {
  const config = sessionVoiceConfig("Thread context");
  expect(config.model).toBe("gpt-realtime");
  expect(config.tools.map((tool) => tool.name)).toEqual(["request_agent_help"]);
  expect(config.instructions).toContain("Thread context");
  expect(config.tool_choice).toBe("auto");
  expect(config.audio.input.turn_detection.create_response).toBe(true);
  expect(config.audio.input.turn_detection.interrupt_response).toBe(true);
});

test("voice route rejects machine and claimed identities before spending or session lookup", async () => {
  for (const body of [{}, { user: "Jaap", sdp: "offer" }]) {
    const req = new Request("http://localhost/api/sessions/test/voice", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const response = await handleSessionVoiceRoutes({
      req,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      publicPrefix: "",
    });
    expect(response?.status).toBe(401);
  }
});

test("voice route bounds and validates offers", async () => {
  for (const sdp of [null, "", "x".repeat(65537)]) {
    const req = new Request("http://localhost/api/sessions/test/voice", {
      method: "POST",
      body: JSON.stringify({ sdp }),
    });
    const response = await handleSessionVoiceRoutes({
      req,
      url: new URL(req.url),
      path: new URL(req.url).pathname,
      publicPrefix: "",
      authUser: { login: "alice", name: "Alice" },
    });
    expect(response?.status).toBe(400);
  }
});

test("SDP exchange uses the server key and approval-only policy, returns only the answer", async () => {
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "private-test-key",
  );
  restores.push(() => key.mockRestore());
  let request: RequestInit | undefined;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/realtime/calls");
        request = init;
        return new Response("answer");
      },
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  expect(
    await createSessionVoiceAnswer(
      "offer",
      new AbortController().signal,
      "Thread context",
    ),
  ).toBe("answer");
  expect(request?.headers).toEqual({
    Authorization: "Bearer private-test-key",
  });
  const form = request?.body as FormData;
  expect(form.get("sdp")).toBe("offer");
  expect(JSON.parse(String(form.get("session")))).toEqual(
    sessionVoiceConfig("Thread context"),
  );
});

test("provider failures do not leak response bodies or credentials", async () => {
  const key = spyOn(voice, "requireVoiceApiKey").mockResolvedValue(
    "private-test-key",
  );
  restores.push(() => key.mockRestore());
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => new Response("private provider diagnostic", { status: 403 }),
      { preconnect() {} },
    ),
  );
  restores.push(() => fetcher.mockRestore());
  await expect(
    createSessionVoiceAnswer(
      "offer",
      new AbortController().signal,
      "Thread context",
    ),
  ).rejects.toThrow("OpenAI could not start the voice call (HTTP 403).");
});
