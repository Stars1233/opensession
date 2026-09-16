import { describe, expect, test } from "bun:test";
import { validNewRepoName } from "./repo-name";

describe("validNewRepoName", () => {
  test("accepts ordinary repository names", () => {
    expect(validNewRepoName("widget")).toBe(true);
    expect(validNewRepoName("my-app_2.0")).toBe(true);
    expect(validNewRepoName("A")).toBe(true);
  });

  test("rejects non-strings, empty names, and a leading separator", () => {
    expect(validNewRepoName(undefined)).toBe(false);
    expect(validNewRepoName(42)).toBe(false);
    expect(validNewRepoName("")).toBe(false);
    expect(validNewRepoName("-widget")).toBe(false);
    expect(validNewRepoName(".widget")).toBe(false);
  });

  test("rejects path, shell, and URL characters", () => {
    expect(validNewRepoName("acme/widget")).toBe(false);
    expect(validNewRepoName("a b")).toBe(false);
    expect(validNewRepoName("a;b")).toBe(false);
    expect(validNewRepoName("a$(b)")).toBe(false);
    expect(validNewRepoName("a\\b")).toBe(false);
  });

  test("rejects traversal and the bare-origin suffix", () => {
    expect(validNewRepoName("a..b")).toBe(false);
    expect(validNewRepoName("widget.git")).toBe(false);
    expect(validNewRepoName("widget.GIT")).toBe(false);
  });

  test("caps the length at GitHub's 100 characters", () => {
    expect(validNewRepoName("a".repeat(100))).toBe(true);
    expect(validNewRepoName("a".repeat(101))).toBe(false);
  });
});
