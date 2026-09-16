import { beforeEach, expect, mock, test } from "bun:test";

let localReads = 0;
let replies: string[] = [];
mock.module("./media", () => ({
  splitSlackMedia: async (text: string) => {
    localReads++;
    return { text, media: [] };
  },
}));
mock.module("./streamer", () => ({
  SlackStreamer: class {
    async stop(text: string) {
      replies.push(text);
    }
  },
}));
mock.module("../../server/config", () => ({
  configuredServer: () => ({ publicBaseUrl: "https://os.example.test" }),
}));
const { mirrorSlackSessionReply } = await import("./session-reply");
const target = { channel: "C1", threadTs: "123.1" };
beforeEach(() => {
  localReads = 0;
  replies = [];
});

test("Sandbox and automation markers cannot upload gateway files", async () => {
  await mirrorSlackSessionReply(target, {
    sessionId: "os-sandbox",
    assistantText:
      "Here is the screenshot.\nOPENSESSION_IMAGE: /home/ubuntu/private.png",
  });
  expect(localReads).toBe(0);
  expect(replies[0]).not.toContain("/home/ubuntu/private.png");
  expect(replies[0]).toContain("https://os.example.test/session/os-sandbox");
});

test("trusted host replies retain media upload support", async () => {
  await mirrorSlackSessionReply(target, {
    sessionId: "os-host",
    localMedia: true,
    assistantText: "Host reply",
  });
  expect(localReads).toBe(1);
  expect(replies[0]).toBe("Host reply");
});

test("setup and run errors are answered in the originating Slack thread", async () => {
  await mirrorSlackSessionReply(target, {
    sessionId: "os-failed",
    assistantText: "Partial answer",
    error: "Sandbox unavailable",
  });
  expect(replies[0]).toContain("Run failed: Sandbox unavailable");
  expect(replies[0]).not.toContain("Partial answer");
});

test("non-Slack turns have no Slack side effect", async () => {
  await mirrorSlackSessionReply(undefined, {
    sessionId: "os-web",
    assistantText: "Web answer",
  });
  expect(localReads).toBe(0);
  expect(replies).toEqual([]);
});
