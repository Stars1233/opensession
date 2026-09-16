import { describe, expect, test } from "bun:test";
import {
  githubNewRepoUrl,
  newRepoRegistration,
  validGithubOwner,
} from "./new-repo";

describe("GitHub browser creation", () => {
  test("prefills the GitHub page without credentials or a callback", () => {
    const url = new URL(githubNewRepoUrl("acme-org", "my-project"));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      owner: "acme-org",
      name: "my-project",
      visibility: "private",
      readme: "1",
    });
  });

  test("encodes query values rather than allowing extra parameters", () => {
    const url = new URL(githubNewRepoUrl("acme", "widget&visibility=public"));
    expect(url.searchParams.get("name")).toBe("widget&visibility=public");
    expect(url.searchParams.getAll("visibility")).toEqual(["private"]);
  });

  test("connect uses remote registration for organizations and personal accounts", () => {
    for (const owner of ["acme-org", "solo-dev"]) {
      expect(newRepoRegistration("widget", owner)).toEqual({
        source: "github",
        fullName: `${owner}/widget`,
      });
    }
  });

  test("server-only creation still uses the local creation route", () => {
    expect(newRepoRegistration("widget")).toEqual({
      source: "new",
      name: "widget",
    });
  });

  test("accepts account names, not URLs, paths or malformed owners", () => {
    for (const owner of ["acme-org", "solo", "a", "A1", "a".repeat(39)])
      expect(validGithubOwner(owner)).toBe(true);
    for (const owner of [
      "",
      "-acme",
      "acme-",
      "acme--org",
      "a/b",
      "https://github.com/acme",
      "a".repeat(40),
    ])
      expect(validGithubOwner(owner)).toBe(false);
  });
});
