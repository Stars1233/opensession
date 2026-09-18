import { expect, test } from "bun:test";
import {
  SessionVoiceApproval,
  voiceApprovalDecision,
} from "./session-voice-approval";

const request = {
  callId: "proposal",
  target: "luna" as const,
  prompt: "Explain the result",
  reason: "Second opinion",
};

test.each(["Yes, please!", "go ahead", "Sure.", "ja graag"])(
  "accepts unambiguous approval: %s",
  (text) => {
    expect(voiceApprovalDecision(text)).toBe("approved");
  },
);
test.each(["no thanks", "Cancel that", "nee"])(
  "recognizes decline: %s",
  (text) => {
    expect(voiceApprovalDecision(text)).toBe("declined");
  },
);
test.each([
  "yes but don't send it",
  "maybe",
  "what do you mean",
  "yesterday",
  "yes no",
  "",
])("fails closed on ambiguous speech: %s", (text) => {
  expect(voiceApprovalDecision(text)).toBe("unclear");
});

test("only our matching spoken question arms the next microphone utterance", () => {
  const gate = new SessionVoiceApproval();
  gate.propose(request);
  gate.questionCreated("other-response", "other-proposal");
  gate.playbackStarted("other-response");
  gate.speechStarted("old-speech");
  expect(gate.transcript("old-speech", "yes")).toBeNull();
  gate.questionCreated("our-response", "proposal");
  gate.playbackStarted("our-response");
  expect(gate.transcript("old-speech", "yes")).toBeNull();
  gate.speechStarted("new-speech");
  expect(gate.transcript("new-speech", "yes please")).toEqual({
    request,
    decision: "approved",
  });
  expect(gate.transcript("new-speech", "yes please")).toBeNull();
});

test("unclear answers revoke the proposal instead of leaving a latent approval", () => {
  const gate = new SessionVoiceApproval();
  gate.propose(request);
  gate.questionCreated("question", "proposal");
  gate.playbackStarted("question");
  gate.speechStarted("speech");
  expect(gate.transcript("speech", "Yes but not yet")?.decision).toBe(
    "unclear",
  );
  expect(gate.pending).toBe(false);
  gate.speechStarted("later");
  expect(gate.transcript("later", "yes")).toBeNull();
});
