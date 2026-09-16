const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Profile IDs, not account names or CLI fragments. Tailscale generates hex IDs.
function profileId(value) {
  return typeof value === "string" && /^[a-f0-9]{4,64}$/i.test(value)
    ? value
    : null;
}

function parseProfiles(text) {
  const rows = JSON.parse(text);
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) => !row || !profileId(row.id) || typeof row.selected !== "boolean",
    ) ||
    rows.filter((row) => row.selected).length > 1
  ) {
    throw new Error("Update Tailscale to read its saved profiles.");
  }
  return rows.map((row) => ({
    id: row.id,
    label:
      [row.tailnet, row.account || row.nickname].filter(Boolean).join(" · ") ||
      row.id,
    selected: row.selected,
  }));
}

class Tailscale {
  constructor({ platform = process.platform, run, findBinary } = {}) {
    this.platform = platform;
    this.run =
      run ||
      ((file, args, timeout) =>
        new Promise((resolve, reject) => {
          execFile(
            file,
            args,
            {
              timeout,
              maxBuffer: 1024 * 1024,
              env: { ...process.env, TS_BE_CLI: "1" },
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        }));
    this.findBinary =
      findBinary ||
      (async () => {
        // Finder launches have a minimal PATH. Never search the working directory
        // or accept an executable path from a renderer/server.
        for (const file of [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          path.join(
            os.homedir(),
            "Applications/Tailscale.app/Contents/MacOS/Tailscale",
          ),
          "/opt/homebrew/bin/tailscale",
          "/usr/local/bin/tailscale",
        ]) {
          try {
            await access(file, constants.X_OK);
            return file;
          } catch {}
        }
        throw new Error(
          "Install Tailscale, open it, and sign in to your tailnets first.",
        );
      });
  }

  async command(args, timeout = 8000) {
    if (this.platform !== "darwin")
      throw new Error("Tailnet switching is available on macOS.");
    const file = await this.findBinary();
    try {
      return await this.run(file, args, timeout);
    } catch (error) {
      if (error.killed)
        throw new Error(
          "Tailscale took too long. Open Tailscale to check the connection, then retry.",
        );
      throw new Error(
        "Couldn't contact Tailscale. Open it and check that you're signed in and allowed to switch profiles.",
      );
    }
  }

  async profiles() {
    const text = await this.command(["switch", "--list", "--json"]);
    try {
      return parseProfiles(text);
    } catch {
      throw new Error(
        "Couldn't read Tailscale profiles. Update Tailscale and try again.",
      );
    }
  }

  async switchTo(id) {
    if (!profileId(id)) throw new Error("Choose a saved Tailscale profile.");
    const profiles = await this.profiles();
    const profile = profiles.find((row) => row.id === id);
    if (!profile)
      throw new Error(
        "That profile is no longer saved in Tailscale. Choose another profile.",
      );
    if (!profile.selected) await this.command(["switch", id], 25000);
    await this.verify(id);
  }

  async verify(id) {
    const status = JSON.parse(
      await this.command(["status", "--json", "--peers=false"]),
    );
    if (status.BackendState !== "Running") {
      throw new Error(
        "Tailscale isn't connected. Open Tailscale to connect or sign in, then retry.",
      );
    }
    if (!(await this.profiles()).some((row) => row.id === id && row.selected)) {
      throw new Error(
        "The active Tailscale profile changed. Retry when you're ready to switch.",
      );
    }
  }
}

// One explicit attempt owns the previous profile across retries. It never
// switches back automatically: a person may have changed networks elsewhere.
class TailnetConnection {
  constructor({
    cli,
    account,
    probe,
    changed = () => {},
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.cli = cli;
    this.account = account;
    this.probe = probe;
    this.changed = changed;
    this.wait = wait;
    this.previousId = undefined;
    this.state = { phase: "idle", error: null };
  }

  get busy() {
    return ["connecting", "restoring"].includes(this.state.phase);
  }

  snapshot() {
    return {
      ...this.state,
      label: this.account.label,
      host: new URL(this.account.url).host,
      canBack:
        !!this.previousId &&
        this.previousId !== this.account.tailscaleProfileId,
    };
  }

  update(phase, error = null) {
    this.state = { phase, error };
    this.changed(this.snapshot());
  }

  async connect() {
    if (this.busy) return false;
    this.update("connecting");
    try {
      if (this.previousId === undefined) {
        const profiles = await this.cli.profiles();
        this.previousId = profiles.find((row) => row.selected)?.id || null;
      }
      await this.cli.switchTo(this.account.tailscaleProfileId);
      for (let attempt = 0; attempt < 4; attempt++) {
        if ((await this.probe(this.account.url)).ok) {
          await this.cli.verify(this.account.tailscaleProfileId);
          this.update("connected");
          return true;
        }
        if (attempt < 3) await this.wait(800);
      }
      throw new Error(
        "The server is still unreachable on this tailnet. Check its address or try another profile.",
      );
    } catch (error) {
      this.update("error", error.message);
      return false;
    }
  }

  async restore() {
    if (this.busy || !this.snapshot().canBack) return false;
    this.update("restoring");
    try {
      const selected = (await this.cli.profiles()).find(
        (row) => row.selected,
      )?.id;
      if (
        selected !== this.previousId &&
        selected !== this.account.tailscaleProfileId
      ) {
        throw new Error(
          "Tailscale changed outside Open Session. Choose your network in Tailscale instead.",
        );
      }
      await this.cli.switchTo(this.previousId);
      this.update("restored");
      return true;
    } catch (error) {
      this.update("error", error.message);
      return false;
    }
  }
}

module.exports = { Tailscale, TailnetConnection, parseProfiles, profileId };
