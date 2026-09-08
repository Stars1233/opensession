import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_RUN_AUTH_FILE_ENV } from "./github-auth";
import { githubCodeRunEnv, githubReadRunEnv } from "./pi-runner";

const keys = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_GITHUB_AUTH_STORE",
  GITHUB_RUN_AUTH_FILE_ENV,
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("recovered GitHub code-run credentials", () => {
  test("fails closed instead of selecting a connected human", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-recovered-github-"));
    try {
      const cwd = join(dir, "repo");
      mkdirSync(cwd);
      const config = join(dir, "config.json");
      const users = join(dir, "github-users.json");
      writeFileSync(
        config,
        JSON.stringify({
          integrations: { github: {} },
          repos: {
            app: {
              repo: cwd,
              ghRepo: "tellahq/app",
              defaultBranch: "main",
            },
          },
        }),
      );
      writeFileSync(
        users,
        JSON.stringify({
          users: {
            alice: {
              login: "alice",
              token: "human-token",
              source: "device",
              connectedAt: new Date().toISOString(),
            },
          },
        }),
      );
      process.env.OPENSESSION_CONFIG = config;
      process.env.OPENSESSION_GITHUB_AUTH_STORE = users;
      delete process.env[GITHUB_RUN_AUTH_FILE_ENV];

      const env = await githubCodeRunEnv(cwd);
      expect(env.GH_TOKEN).toBe("");
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(Object.values(env)).not.toContain("human-token");

      // The read-run variant holds the same boundary: an unavailable App
      // mint yields an empty credential with the SSH rewrite, never a
      // connected human's token.
      const readEnv = await githubReadRunEnv(cwd);
      expect(readEnv.GH_TOKEN).toBe("");
      expect(readEnv.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
      expect(Object.values(readEnv)).not.toContain("human-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote recovery consumes only its projected run-scoped file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-projected-github-"));
    try {
      const auth = join(dir, "github-auth.json");
      writeFileSync(
        auth,
        JSON.stringify({ GH_TOKEN: "projected-service-token" }),
      );
      process.env[GITHUB_RUN_AUTH_FILE_ENV] = auth;

      const env = await githubCodeRunEnv("/remote/unregistered/repo");
      expect(env.GH_TOKEN).toBe("projected-service-token");
      expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent git identity", () => {
  const savedSlug = process.env.OPENSESSION_GITHUB_APP_SLUG;
  const savedFetch = globalThis.fetch;
  afterEach(() => {
    if (savedSlug === undefined) delete process.env.OPENSESSION_GITHUB_APP_SLUG;
    else process.env.OPENSESSION_GITHUB_APP_SLUG = savedSlug;
    globalThis.fetch = savedFetch;
  });

  test("never carries a person's git identity; the person is the co-author", async () => {
    const { agentGitIdentityEnv, GIT_COAUTHOR_ENV } =
      await import("./pi-runner");
    process.env.OPENSESSION_GITHUB_APP_SLUG = "example-app";
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error("offline");
      },
      { preconnect: savedFetch.preconnect },
    );
    const env = await agentGitIdentityEnv({
      name: "Alice Example",
      email: "alice@example.com",
    });
    expect(env.GIT_AUTHOR_NAME).toBe("example-app[bot]");
    expect(env.GIT_COMMITTER_NAME).toBe("example-app[bot]");
    expect(env.GIT_AUTHOR_EMAIL).toBe(
      "example-app[bot]@users.noreply.github.com",
    );
    expect(env[GIT_COAUTHOR_ENV]).toBe("Alice Example <alice@example.com>");
    expect(JSON.stringify(env)).not.toContain('GIT_AUTHOR_NAME":"Alice');
  });

  test("without an App the bot identity is absent and git's own config decides", async () => {
    const { agentGitIdentityEnv, GIT_COAUTHOR_ENV } =
      await import("./pi-runner");
    delete process.env.OPENSESSION_GITHUB_APP_SLUG;
    process.env.OPENSESSION_CONFIG = "/nonexistent/config.json";
    const env = await agentGitIdentityEnv({ name: "Nightly sweep", email: "" });
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    // A label identity has no email and gets no trailer.
    expect(env[GIT_COAUTHOR_ENV]).toBeUndefined();
  });
});
