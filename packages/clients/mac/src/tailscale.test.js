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

// Mirrors Go tabwriter's fixed-width, Unicode-code-point columns.
function profileTable(rows) {
  const all = [["ID", "Tailnet", "Account"], ...rows];
  const widths = [0, 1].map(
    (column) =>
      Math.max(...all.map((row) => Array.from(row[column]).length)) + 2,
  );
  return (
    all
      .map((row) =>
        row
          .map((value, index) =>
            index < 2
              ? value + " ".repeat(widths[index] - Array.from(value).length)
              : value,
          )
          .join(""),
      )
      .join("\n") + "\n"
  );
}

const legacyProfiles = profileTable([
  ["aaaa", "Personal tailnet", "Personal account*"],
  ["bbbb", "Work", "Work account"],
]);

describe("Tailscale CLI", () => {
  test("sets CLI mode and a plain TERM even when launched without a terminal", async () => {
    const previousTerm = process.env.TERM;
    const cli = new Tailscale({
      platform: "darwin",
      findBinary: async () => process.execPath,
    });
    try {
      for (const term of [undefined, "", "xterm-256color"]) {
        if (term === undefined) delete process.env.TERM;
        else process.env.TERM = term;
        const output = await cli.command([
          "--eval",
          "console.log(JSON.stringify({ term: process.env.TERM, cli: process.env.TS_BE_CLI }))",
        ]);
        expect(JSON.parse(output)).toEqual({ term: "dumb", cli: "1" });
        expect(process.env.TERM).toBe(term);
      }
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
    }
  });

  test("reads legacy table columns, spaced names and the selected marker", () => {
    expect(parseProfiles(legacyProfiles)).toEqual([
      {
        id: "aaaa",
        label: "Personal tailnet · Personal account",
        selected: true,
      },
      { id: "bbbb", label: "Work · Work account", selected: false },
    ]);
    expect(
      parseProfiles(
        profileTable([
          ["abcd", "🦊 Studio team", "My work login*"],
          ["cdef", "Personal", "Personal login"],
        ]).replaceAll("\n", "\r\n"),
      ),
    ).toEqual([
      { id: "abcd", label: "🦊 Studio team · My work login", selected: true },
      { id: "cdef", label: "Personal · Personal login", selected: false },
    ]);
    expect(parseProfiles(profileTable([]))).toEqual([]);
  });

  test("rejects malformed or ambiguous legacy output without guessing IDs", () => {
    for (const invalid of [
      "",
      "Tailscale daemon is not running",
      "[]\nWarning: unexpected output",
      profileTable([["--help", "Work", "Account*"]]),
      profileTable([
        ["aaaa", "Work", "One*"],
        ["bbbb", "Work", "Two*"],
      ]),
      profileTable([
        ["aaaa", "Work", "One"],
        ["aaaa", "Work", "Two*"],
      ]),
    ])
      expect(() => parseProfiles(invalid)).toThrow();
  });

  test("falls back only when --json is unsupported and remembers the older CLI", async () => {
    const calls = [];
    const cli = new Tailscale({
      platform: "darwin",
      findBinary: async () => "/fixed/cli",
      run: async (_file, args) => {
        calls.push(args);
        if (args.includes("--json"))
          throw Object.assign(new Error("Command failed"), {
            stderr:
              "flag provided but not defined: -json\nSwitch to a different Tailscale account\n",
          });
        return legacyProfiles;
      },
    });
    expect(await cli.profiles()).toHaveLength(2);
    expect((await cli.profiles())[0].selected).toBe(true);
    expect(calls).toEqual([
      ["switch", "--list", "--json"],
      ["switch", "--list"],
      ["switch", "--list"],
    ]);
  });

  test("does not hide permission failures, timeouts or malformed JSON with a fallback", async () => {
    for (const failure of [
      { stderr: "Permission denied" },
      { killed: true },
      { stderr: "flag provided but not defined: -list" },
      null,
    ]) {
      let calls = 0;
      const cli = new Tailscale({
        platform: "darwin",
        findBinary: async () => "/fixed/cli",
        run: async () => {
          calls++;
          if (failure)
            throw Object.assign(new Error("Command failed"), failure);
          return "not json";
        },
      });
      await expect(cli.profiles()).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

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
