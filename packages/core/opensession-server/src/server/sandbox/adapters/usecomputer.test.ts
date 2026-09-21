import { describe, expect, test } from "bun:test";
import {
  DEFAULT_USE_COMPUTER_API_URL,
  GUEST_PREPARATION,
  guestCommand,
  guestScript,
  parseDetachedExecStatus,
  sleepSnapshotVersion,
  useComputerChord,
  useComputerSandboxId,
  useComputerSettings,
  useComputerTerminalArgv,
  websocketUrl,
} from "./usecomputer";

describe("use.computer settings", () => {
  test("defaults the API base and trims what it keeps", () => {
    expect(useComputerSettings(undefined)).toEqual({
      apiUrl: DEFAULT_USE_COMPUTER_API_URL,
    });
    expect(
      useComputerSettings({
        apiUrl: "https://api.dev.use.computer/",
        reservation: " res-1 ",
      }),
    ).toEqual({ apiUrl: "https://api.dev.use.computer", reservation: "res-1" });
    expect(
      useComputerSettings({ reservation: "  " }).reservation,
    ).toBeUndefined();
  });
});

describe("use.computer naming", () => {
  test("a session's sandbox id is stable and safe for state files", () => {
    expect(useComputerSandboxId("bks-0192-abc")).toBe("uc-bks-0192-abc");
    expect(useComputerSandboxId("weird id/with:chars")).toBe(
      "uc-weird-id-with-chars",
    );
  });

  test("sleep snapshots are named after the sandbox and the moment", () => {
    expect(sleepSnapshotVersion("uc-bks-1", 1_000_000)).toBe(
      "uc-bks-1-sleep-lfls",
    );
  });
});

describe("use.computer guest commands", () => {
  test("the guest script sets the lume layout, the env, and the cwd", () => {
    const script = guestScript("echo hi", {
      cwd: "/Users/lume/worktrees/repo",
      env: { FOO: "a b" },
    });
    expect(script.startsWith("export HOME=/Users/lume PATH=")).toBe(true);
    expect(script).toContain("/Users/lume/.bun/bin:");
    expect(script).toContain("export FOO='a b'; ");
    expect(script.endsWith("cd /Users/lume/worktrees/repo && echo hi")).toBe(
      true,
    );
  });

  test("the service's shell only ever sees base64", () => {
    const command = guestCommand("printf '%s' \"$HOME\"; exit 3");
    expect(command).toMatch(
      /^bash -c "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"$/,
    );
    const encoded = command.match(/printf %s ([A-Za-z0-9+/=]+)/)![1]!;
    expect(Buffer.from(encoded, "base64").toString()).toBe(
      "printf '%s' \"$HOME\"; exit 3",
    );
  });

  test("a detached command's status decodes once it finished", () => {
    expect(parseDetachedExecStatus("")).toBeNull();
    expect(parseDetachedExecStatus("\n")).toBeNull();
    const out = Buffer.from("hello\n").toString("base64");
    const err = Buffer.from("oops").toString("base64");
    expect(parseDetachedExecStatus(`7\n${out}\n${err}\n`)).toEqual({
      exitCode: 7,
      stdout: "hello\n",
      stderr: "oops",
    });
    expect(parseDetachedExecStatus("0\n\n\n")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("guest preparation aliases the canonical workspace home", () => {
    expect(GUEST_PREPARATION).toContain(
      "ln -s /Users/lume /System/Volumes/Data/home/ubuntu",
    );
    expect(GUEST_PREPARATION).toContain("test -d /home/ubuntu/Library");
  });
});

describe("use.computer desktop keys", () => {
  test("translates our chord vocabulary into the service's", () => {
    expect(useComputerChord("cmd+shift+t")).toEqual(["command", "shift", "t"]);
    expect(useComputerChord("Return")).toEqual(["enter"]);
    expect(useComputerChord("ctrl+l")).toEqual(["control", "l"]);
    expect(useComputerChord("opt+Escape")).toEqual(["alt", "escape"]);
    expect(useComputerChord("A")).toEqual(["A"]);
    expect(() => useComputerChord(" + ")).toThrow(/empty key chord/);
  });
});

describe("use.computer transports", () => {
  test("service sockets follow the API base", () => {
    expect(
      websocketUrl("https://api.use.computer", "/v1/sandboxes/sb-1/ssh"),
    ).toBe("wss://api.use.computer/v1/sandboxes/sb-1/ssh");
    expect(websocketUrl("http://localhost:8084", "/v1/x")).toBe(
      "ws://localhost:8084/v1/x",
    );
  });

  test("the terminal ssh names the proxy and the cwd, never a secret", () => {
    const argv = useComputerTerminalArgv({
      wsUrl: "wss://api.use.computer/v1/sandboxes/sb-1/ssh",
      user: "lume",
      cwd: "/Users/lume/worktrees/repo x",
      bun: "/usr/local/bin/bun",
    });
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-tt");
    const proxy = argv[argv.indexOf("-o") + 1]!;
    expect(proxy.startsWith("ProxyCommand=/usr/local/bin/bun ")).toBe(true);
    expect(proxy).toContain("scripts/ws-stdio-proxy.ts");
    expect(
      proxy.endsWith(" wss://api.use.computer/v1/sandboxes/sb-1/ssh"),
    ).toBe(true);
    expect(argv).toContain("PubkeyAuthentication=no");
    expect(argv.at(-2)).toBe("lume@use-computer-sandbox");
    expect(argv.at(-1)).toBe("cd '/Users/lume/worktrees/repo x'; exec zsh -il");
    expect(argv.join(" ")).not.toContain("uc_live");
  });
});
