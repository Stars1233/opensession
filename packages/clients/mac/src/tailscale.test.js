const { describe, expect, test } = require("bun:test");
const {
  Tailscale,
  TailnetConnection,
  parseProfiles,
  profileId,
} = require("./tailscale");

const rows = (selected = "aaaa") => [
  {
    id: "aaaa",
    tailnet: "Personal",
    account: "person@example.test",
    selected: selected === "aaaa",
  },
  {
    id: "bbbb",
    tailnet: "Work",
    nickname: "Work account",
    selected: selected === "bbbb",
  },
];

describe("Tailscale CLI", () => {
  test("parses the CLI's lowercase JSON fields without exposing raw records", () => {
    expect(parseProfiles(JSON.stringify(rows()))).toEqual([
      { id: "aaaa", label: "Personal · person@example.test", selected: true },
      { id: "bbbb", label: "Work · Work account", selected: false },
    ]);
    for (const invalid of [
      "{}",
      "null",
      '[{"id":"aaaa"}]',
      JSON.stringify(rows().map((row) => ({ ...row, selected: true }))),
    ]) {
      expect(() => parseProfiles(invalid)).toThrow();
    }
  });

  test("only accepts generated profile IDs, never flags or subcommands", () => {
    for (const invalid of [
      undefined,
      {},
      "--help",
      "remove",
      "aaaa; open /tmp",
      "work@example.test",
      "",
    ]) {
      expect(profileId(invalid)).toBeNull();
    }
    expect(profileId("abcd")).toBe("abcd");
  });

  function fixture(initial = "aaaa", backend = "Running") {
    let selected = initial;
    const calls = [];
    const cli = new Tailscale({
      platform: "darwin",
      findBinary: async () =>
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      run: async (file, args, timeout) => {
        calls.push({ file, args, timeout });
        if (args[0] === "status")
          return JSON.stringify({ BackendState: backend });
        if (args[1] === "--list") return JSON.stringify(rows(selected));
        selected = args[1];
        return "Success.";
      },
    });
    return { cli, calls };
  }

  test("uses fixed argument arrays and waits for Running and the selected profile", async () => {
    const { cli, calls } = fixture();
    await cli.switchTo("bbbb");
    expect(calls.map((call) => call.args)).toEqual([
      ["switch", "--list", "--json"],
      ["switch", "bbbb"],
      ["status", "--json", "--peers=false"],
      ["switch", "--list", "--json"],
    ]);
    expect(calls[1].timeout).toBe(25000);
    expect(calls[0].timeout).toBe(8000);
  });

  test("skips an already selected profile and rejects missing or expired profiles", async () => {
    const { cli, calls } = fixture("bbbb");
    await cli.switchTo("bbbb");
    expect(calls.some((call) => call.args[1] === "bbbb")).toBe(false);
    await expect(cli.switchTo("cccc")).rejects.toThrow("no longer saved");
    await expect(cli.switchTo("--help")).rejects.toThrow("Choose a saved");
    await expect(
      fixture("aaaa", "NeedsLogin").cli.switchTo("bbbb"),
    ).rejects.toThrow("isn't connected");
  });

  test("fails closed outside macOS, on timeouts, and on unsupported CLI JSON", async () => {
    const run = async () => {
      throw Object.assign(new Error("private CLI details"), { killed: true });
    };
    const linux = new Tailscale({ platform: "linux", run });
    await expect(linux.profiles()).rejects.toThrow("macOS");
    const cli = new Tailscale({
      platform: "darwin",
      findBinary: async () => "/fixed/cli",
      run,
    });
    await expect(cli.profiles()).rejects.toThrow("too long");
    cli.run = async () => "not json";
    await expect(cli.profiles()).rejects.toThrow("Update Tailscale");
  });
});

describe("TailnetConnection", () => {
  function fixture({
    selected = "aaaa",
    reachable = false,
    switchError = false,
  } = {}) {
    const calls = [];
    const state = { selected, reachable, switchError, probes: 0 };
    const cli = {
      profiles: async () => rows(state.selected),
      switchTo: async (id) => {
        calls.push(id);
        state.selected = id;
        if (state.switchError)
          throw new Error("CLI timed out after changing profiles");
      },
      verify: async (id) => {
        if (state.selected !== id) throw new Error("Profile changed");
      },
    };
    const connection = new TailnetConnection({
      cli,
      account: {
        id: "work",
        label: "Work",
        url: "https://work.example.test/",
        tailscaleProfileId: "bbbb",
      },
      probe: async () => {
        state.probes++;
        return { ok: state.reachable };
      },
      wait: async () => {},
    });
    return { connection, state, calls, cli };
  }

  test("checks reachability with a bounded retry, preserving recovery across retries", async () => {
    const { connection, state, calls } = fixture();
    expect(await connection.connect()).toBe(false);
    expect(state.probes).toBe(4);
    expect(connection.snapshot()).toMatchObject({
      phase: "error",
      canBack: true,
    });
    expect(await connection.connect()).toBe(false);
    expect(connection.previousId).toBe("aaaa");
    expect(await connection.restore()).toBe(true);
    expect(calls).toEqual(["bbbb", "bbbb", "aaaa"]);
  });

  test("only succeeds once the server is reachable on the selected network", async () => {
    const { connection, state } = fixture({ reachable: true });
    expect(await connection.connect()).toBe(true);
    expect(state.probes).toBe(1);
    expect(connection.snapshot().phase).toBe("connected");
  });

  test("allows recovery after a CLI timeout that may have changed networks", async () => {
    const { connection, state } = fixture({ switchError: true });
    expect(await connection.connect()).toBe(false);
    expect(connection.snapshot().canBack).toBe(true);
    state.switchError = false;
    expect(await connection.restore()).toBe(true);
    expect(state.selected).toBe("aaaa");
  });

  test("never automatically restores, or overwrites a manual network change", async () => {
    const { connection, state, calls } = fixture();
    await connection.connect();
    expect(calls).toEqual(["bbbb"]);
    state.selected = "cccc";
    expect(await connection.restore()).toBe(false);
    expect(calls).toEqual(["bbbb"]);
    expect(connection.snapshot().error).toContain("outside Open Session");
  });

  test("refuses overlapping connect and rollback operations", async () => {
    const { connection, cli, state } = fixture({ reachable: true });
    let release;
    cli.switchTo = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const first = connection.connect();
    await Promise.resolve();
    expect(await connection.connect()).toBe(false);
    expect(await connection.restore()).toBe(false);
    state.selected = "bbbb";
    release();
    expect(await first).toBe(true);
  });

  test("does not offer rollback when there was no prior profile or it was already selected", async () => {
    for (const selected of [null, "bbbb"]) {
      const { connection } = fixture({ selected });
      await connection.connect();
      expect(connection.snapshot().canBack).toBe(false);
      expect(await connection.restore()).toBe(false);
    }
  });
});
