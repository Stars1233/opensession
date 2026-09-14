import { describe, expect, test } from "bun:test";
import { issueBranch, issueLabelCommand } from "./issue";

const base = {
  action: "labeled",
  labelName: "os",
  isPullRequest: false,
  senderIsBot: false,
  senderIsTrusted: true,
};

describe("issue label gate", () => {
  test("a trusted person adding `os` to a plain issue starts a session", () => {
    expect(issueLabelCommand(base)).toBe("start");
  });

  test("only the labeled action counts", () => {
    expect(issueLabelCommand({ ...base, action: "opened" })).toBe("ignore");
    expect(issueLabelCommand({ ...base, action: "unlabeled" })).toBe("ignore");
  });

  test("other labels are ignored, including the PR ones", () => {
    expect(issueLabelCommand({ ...base, labelName: "os-review" })).toBe(
      "ignore",
    );
    expect(issueLabelCommand({ ...base, labelName: "bug" })).toBe("ignore");
    expect(issueLabelCommand({ ...base, labelName: "" })).toBe("ignore");
  });

  test("a PR carrying the label is left to the pull_request handler", () => {
    expect(issueLabelCommand({ ...base, isPullRequest: true })).toBe("ignore");
  });

  test("the bot's own label edits never start a session", () => {
    expect(issueLabelCommand({ ...base, senderIsBot: true })).toBe("ignore");
  });

  test("an untrusted sender is refused, not ignored, so it is logged", () => {
    expect(issueLabelCommand({ ...base, senderIsTrusted: false })).toBe(
      "untrusted",
    );
  });
});

describe("issue branch", () => {
  test("is stable per issue so re-triggers resume the same worktree", () => {
    expect(issueBranch(42)).toBe("issue-42");
    expect(issueBranch(42)).toBe(issueBranch(42));
  });
});
