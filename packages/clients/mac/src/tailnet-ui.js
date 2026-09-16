const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Tailscale, TailnetConnection, profileId } = require("./tailscale");

function fromLocalPage(event, window, page) {
  if (!window || window.isDestroyed()) return false;
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false;
  try {
    const source = new URL(event.senderFrame.url);
    source.search = "";
    source.hash = "";
    return source.href === pathToFileURL(path.join(__dirname, page)).href;
  } catch {
    return false;
  }
}

class TailnetWindows {
  constructor({
    electron = require("electron"),
    cli = new Tailscale(),
    readAccounts,
    writeAccounts,
    probe,
    connectAccount,
    isQuitting = () => false,
  }) {
    this.electron = electron;
    this.cli = cli;
    this.readAccounts = readAccounts;
    this.writeAccounts = writeAccounts;
    this.probe = probe;
    this.connectAccount = connectAccount;
    this.isQuitting = isQuitting;
    this.settingsWindow = null;
    this.connectionWindow = null;
  }

  get switching() {
    return !!this.connectionWindow || !!this.connection?.busy;
  }

  createWindow(parent, page) {
    const window = new this.electron.BrowserWindow({
      parent,
      modal: true,
      width: 560,
      height: 590,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: "Tailscale · Open Session",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.loadFile(path.join(__dirname, page));
    return window;
  }

  settings(parent, accountId) {
    if (!parent || parent.isDestroyed() || this.switching) return;
    if (this.settingsWindow) {
      this.settingsWindow.focus();
      return;
    }
    this.settingsParent = parent;
    this.settingsAccountId = accountId;
    const window = this.createWindow(parent, "tailnet-settings.html");
    this.settingsWindow = window;
    window.on("closed", () => {
      this.settingsWindow = null;
    });
  }

  async settingsState() {
    const { accounts } = this.readAccounts();
    const state = {
      accounts: accounts.map(({ id, label, tailscaleProfileId }) => ({
        id,
        label,
        profileId: tailscaleProfileId || null,
      })),
      activeId: this.settingsAccountId,
      profiles: [],
      error: null,
    };
    try {
      state.profiles = await this.cli.profiles();
    } catch (error) {
      state.error = error.message;
    }
    return state;
  }

  async saveSettings(event, id, selected, connect) {
    const window = this.settingsWindow;
    if (!fromLocalPage(event, window, "tailnet-settings.html") || this.saving)
      return { ok: false };
    if (
      typeof id !== "string" ||
      (selected !== null && !profileId(selected)) ||
      typeof connect !== "boolean"
    )
      return { ok: false };
    this.saving = true;
    try {
      const account = this.readAccounts().accounts.find((row) => row.id === id);
      if (!account) throw new Error("That organization is no longer saved.");
      if (selected) {
        const profile = (await this.cli.profiles()).find(
          (row) => row.id === selected,
        );
        if (!profile)
          throw new Error(
            "That profile is no longer saved in Tailscale. Refresh the list.",
          );
        if (account.tailscaleProfileId !== selected) {
          const { response } = await this.electron.dialog.showMessageBox(
            window,
            {
              type: "warning",
              message: "Allow automatic tailnet switching?",
              detail: `Selecting ${account.label} in Open Session will switch this Mac to ${profile.label}. This changes networking for every app and may disconnect SSH sessions and other Open Session windows. The setting stays on this Mac.`,
              buttons: ["Cancel", "Allow switching"],
              defaultId: 0,
              cancelId: 0,
            },
          );
          if (response !== 1) return { ok: false, error: "No changes saved." };
        }
      }
      if (!fromLocalPage(event, window, "tailnet-settings.html"))
        return { ok: false };
      // Re-read after the CLI/dialog awaits so route and label updates survive.
      const stored = this.readAccounts();
      const current = stored.accounts.find((row) => row.id === id);
      if (!current || current.url !== account.url)
        throw new Error("The organization changed. Reopen Tailscale profiles.");
      current.tailscaleProfileId = selected;
      if (!this.writeAccounts(stored))
        throw new Error("Couldn't save the profile on this Mac.");
      if (connect) {
        const parent = this.settingsParent;
        setImmediate(() => {
          if (window.isDestroyed()) return;
          window.once("closed", () => {
            if (parent && !parent.isDestroyed())
              this.connectAccount(id, parent);
          });
          window.close();
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      this.saving = false;
    }
  }

  connect(parent, account) {
    if (this.switching || !parent || parent.isDestroyed())
      return Promise.resolve(false);
    return new Promise((resolve) => {
      const window = this.createWindow(parent, "tailnet-connecting.html");
      this.connectionWindow = window;
      let result = false;
      const connection = new TailnetConnection({
        cli: this.cli,
        account,
        probe: this.probe,
        changed: (state) => {
          if (!window.isDestroyed())
            window.webContents.send("os1:tailnet-state", state);
        },
      });
      this.connection = connection;
      this.connectionParent = parent;
      const complete = (success) => {
        result = success;
        if (!window.isDestroyed()) window.close();
        else if (this.connection === connection) this.connection = null;
      };
      this.complete = complete;
      window.on("close", (event) => {
        if (connection.busy && !this.isQuitting()) event.preventDefault();
      });
      window.on("closed", () => {
        this.connectionWindow = null;
        if (!connection.busy) this.connection = null;
        resolve(result);
      });
      // Ready-to-show ensures the local recovery UI is painted before networking changes.
      window.once("ready-to-show", () => {
        void connection.connect().then((ok) => {
          if (ok || window.isDestroyed()) complete(ok);
        });
      });
    });
  }

  register() {
    const { ipcMain } = this.electron;
    ipcMain.handle("os1:tailnet-settings", (event) =>
      fromLocalPage(event, this.settingsWindow, "tailnet-settings.html")
        ? this.settingsState()
        : null,
    );
    ipcMain.handle("os1:tailnet-save", (event, id, selected, connect) =>
      this.saveSettings(event, id, selected, connect),
    );
    ipcMain.handle("os1:tailnet-state", (event) =>
      fromLocalPage(event, this.connectionWindow, "tailnet-connecting.html")
        ? this.connection.snapshot()
        : null,
    );
    ipcMain.handle("os1:tailnet-action", async (event, action) => {
      const settings = fromLocalPage(
        event,
        this.settingsWindow,
        "tailnet-settings.html",
      );
      const connecting = fromLocalPage(
        event,
        this.connectionWindow,
        "tailnet-connecting.html",
      );
      if (!settings && !connecting) return;
      if (action === "open") {
        // A fixed application name, never a command supplied by web content.
        const { execFile } = require("node:child_process");
        return new Promise((resolve) => {
          execFile(
            "/usr/bin/open",
            ["-a", "Tailscale"],
            { timeout: 5000 },
            (error) => resolve({ ok: !error }),
          );
        });
      }
      if (settings) {
        if (action === "close") this.settingsWindow.close();
        return;
      }
      const connection = this.connection;
      const complete = this.complete;
      if (connection.busy) return;
      if (action === "retry") {
        const ok = await connection.connect();
        if (
          ok ||
          this.connectionWindow?.isDestroyed() ||
          !this.connectionWindow
        )
          complete(ok);
      } else if (action === "back") {
        if ((await connection.restore()) || !this.connectionWindow)
          complete(false);
      } else if (action === "choose") {
        const parent = this.connectionParent;
        const accountId = connection.account.id;
        this.connectionWindow.once("closed", () =>
          this.settings(parent, accountId),
        );
        complete(false);
      } else if (action === "close") complete(false);
    });
  }
}

module.exports = { TailnetWindows, fromLocalPage };
