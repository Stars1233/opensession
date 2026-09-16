import { describe, expect, test } from "bun:test";
import { effectiveSandboxDefault } from "./defaults";

describe("sandbox default precedence", () => {
  test("workspace and personal omissions resolve to None", () => {
    expect(effectiveSandboxDefault("none", "workspace")).toBe("none");
  });

  test("workspace applies until a person overrides it", () => {
    expect(effectiveSandboxDefault("daytona", "workspace")).toBe("daytona");
    expect(effectiveSandboxDefault("daytona", "none")).toBe("none");
    expect(effectiveSandboxDefault("daytona", "box")).toBe("box");
  });

  test("a project's own default beats both, in either direction", () => {
    expect(effectiveSandboxDefault("none", "none", "daytona")).toBe("daytona");
    expect(effectiveSandboxDefault("daytona", "box", "none")).toBe("none");
    expect(effectiveSandboxDefault("daytona", "box", null)).toBe("box");
    expect(effectiveSandboxDefault("daytona", "box", undefined)).toBe("box");
  });
});
