import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  baseRuntimeSignature,
  bootstrapRemoteSandbox,
  bootstrapSignature,
  remoteRunnerHostCommand,
  REMOTE_REPO,
  REMOTE_RUNNER_BINARY,
  type RemoteDriver,
} from "./bootstrap";

const originalConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
const scratch: string[] = [];

afterEach(() => {
  if (originalConfig === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = originalConfig;
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});

/** A driver whose Sandbox is already fully prepared: both markers match. */
function preparedDriver(
  commands: string[],
  other: { exitCode: number } = { exitCode: 0 },
): RemoteDriver {
  return {
    async exec(command) {
      commands.push(command);
      if (
        command.startsWith("cat ") &&
        command.includes(".opensession-base-runtime")
      )
        return { exitCode: 0, stdout: baseRuntimeSignature(), stderr: "" };
      if (command.startsWith("cat "))
        return { exitCode: 0, stdout: `${bootstrapSignature()}\n`, stderr: "" };
      if (
        command.includes(".local/bin/opensession ") ||
        command.includes("workload-identity-client")
      )
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: other.exitCode, stdout: "", stderr: "" };
    },
    async execBackground() {},
    async writeFile() {},
    async ensureStarted() {},
  };
}

describe("remote runner bootstrap", () => {
  test("keeps the guest checkout independent from the host release path", () => {
    expect(REMOTE_REPO).toBe("/home/ubuntu/projects/opensession");
  });

  test("repairs the workload identity client after a provider resume", async () => {
    const commands: string[] = [];
    const driver = preparedDriver(commands);

    await bootstrapRemoteSandbox(driver, "test");

    expect(commands).toHaveLength(4);
    expect(commands[0]).toContain(".opensession-base-runtime");
    expect(commands[1]).toContain(
      "/home/ubuntu/.local/share/opensession/workload-identity-client.ts",
    );
    expect(commands[1]).toContain(
      "test -x /home/ubuntu/.local/bin/opensession",
    );
    expect(commands[2]).toContain(".bks-bootstrapped");
    expect(commands[3]).toContain("bun build --compile");
    expect(commands[3]).toContain("--external '*.html'");
    expect(commands[3]).toContain("--external oxc-transform-react");
    expect(commands[3]).toContain(REMOTE_RUNNER_BINARY);
  });

  test("a workspace Sandbox gets the base runtime and no runner payload", async () => {
    const commands: string[] = [];
    await bootstrapRemoteSandbox(preparedDriver(commands), "test", {
      runtime: "workspace",
    });
    expect(commands).toHaveLength(2);
    expect(commands.join("\n")).not.toContain(".bks-bootstrapped");
    expect(commands.join("\n")).not.toContain(REMOTE_REPO);
  });

  test("the base runtime signature names no runner commit", () => {
    expect(baseRuntimeSignature()).not.toContain(bootstrapSignature());
    expect(baseRuntimeSignature()).toStartWith("base+node@");
  });

  test("reports a killed compiler even when it produced no output", async () => {
    const driver = preparedDriver([], { exitCode: 137 });
    await expect(bootstrapRemoteSandbox(driver, "test")).rejects.toThrow(
      "runner host repair, exit 137): no command output",
    );
  });

  test("preserves fetch failures instead of masking them with a checkout error", async () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-bootstrap-fetch-"));
    scratch.push(root);
    const config = join(root, "sandbox.json");
    writeFileSync(
      config,
      JSON.stringify({
        runnerRepoUrl: "https://github.com/tellahq/opensession.git",
        runnerSha: "deadbeef",
        cloneCredential: { type: "https-token", token: "runner-clone-secret" },
      }),
    );
    process.env.OPENSESSION_SANDBOX_CONFIG = config;
    let fetchCommand = "";
    const driver: RemoteDriver = {
      async exec(command) {
        if (command.startsWith("cat "))
          return { exitCode: 1, stdout: "", stderr: "" };
        if (command.includes("fetch --depth 1")) {
          fetchCommand = command;
          return {
            exitCode: 128,
            stdout: "",
            stderr:
              "fatal: unable to access 'https://x-access-token:runner-clone-secret@github.com/tellahq/opensession.git/': Could not resolve host: github.com",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };
    let message = "";
    try {
      await bootstrapRemoteSandbox(driver, "test");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Could not resolve host: github.com");
    expect(message).not.toContain("runner-clone-secret");
    expect(fetchCommand).toContain(
      ` && git -C ${REMOTE_REPO} checkout --detach`,
    );
    expect(fetchCommand).not.toContain("2>/dev/null");
  });

  test("prefers the compiled runner host with a source fallback", () => {
    const command = remoteRunnerHostCommand("/runs/rh-test/spec.json");
    expect(command).toContain(
      `${REMOTE_RUNNER_BINARY} runner-host /runs/rh-test/spec.json`,
    );
    expect(command).toContain("bun run");
    expect(command).toContain(
      "/packages/core/opensession-server/src/runner-host/host.ts",
    );
  });

  test("creates the user bin directory before linking the workload identity client", async () => {
    const root = mkdtempSync(join(tmpdir(), "opensession-bootstrap-install-"));
    scratch.push(root);
    const config = join(root, "sandbox.json");
    writeFileSync(
      config,
      JSON.stringify({
        runnerRepoUrl: "https://github.com/tellahq/opensession.git",
        cloneCredential: { type: "https-token", token: "runner-clone-secret" },
      }),
    );
    process.env.OPENSESSION_SANDBOX_CONFIG = config;

    const commands: string[] = [];
    const driver: RemoteDriver = {
      async exec(command) {
        commands.push(command);
        if (command.startsWith("cat "))
          return { exitCode: 1, stdout: "", stderr: "" };
        if (
          command.includes(
            "test -f /home/ubuntu/projects/opensession/package.json",
          )
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };

    await bootstrapRemoteSandbox(driver, "test");

    const install = commands.find((command) =>
      command.includes(".local/bin/opensession"),
    );
    expect(install).toStartWith("mkdir -p /home/ubuntu/.local/bin && ");
    const compile = commands.find((command) =>
      command.includes("bun build --compile"),
    );
    expect(compile).toContain(
      "rm -f /home/ubuntu/.local/bin/opensession-runner",
    );
    expect(compile).toContain("--external '*.html'");
    expect(compile).toContain("--external oxc-transform-react");
    const ghInstall = commands.find((command) =>
      command.includes("releases/download/v2.83.1"),
    );
    expect(ghInstall).toContain("sha256sum -c -");
    expect(ghInstall).toContain("/usr/local/bin/gh");
    const originScrub = commands.find((command) =>
      command.includes("remote set-url origin"),
    );
    expect(originScrub).toContain("https://github.com/tellahq/opensession.git");
    expect(originScrub).not.toContain("runner-clone-secret");
  });
});
