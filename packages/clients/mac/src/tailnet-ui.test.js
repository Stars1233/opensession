const { describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { TailnetWindows, fromLocalPage } = require("./tailnet-ui");

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: "" };
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.send = () => {};
  }
  isDestroyed() {
    return this.destroyed;
  }
  loadFile(file) {
    this.webContents.mainFrame.url = pathToFileURL(file).href;
  }
  getContentBounds() {
    return this.bounds || { x: 100, y: 80, width: 1100, height: 760 };
  }
  setBounds(bounds) {
    this.bounds = { ...bounds };
  }
  show() {}
  focus() {}
  close() {
    let prevent = false;
    this.emit("close", {
      preventDefault() {
        prevent = true;
      },
    });
    if (!prevent) this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  event() {
    return {
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame,
    };
  }
}

function fixture() {
  const state = {
    stored: {
      accounts: [
        { id: "work", label: "Work", url: "https://work.example.test/" },
      ],
      activeId: "work",
    },
    profiles: [
      { id: "aaaa", label: "Personal", selected: true },
      { id: "bbbb", label: "Work", selected: false },
    ],
    response: 1,
    prompts: 0,
    reads: 0,
    switches: 0,
  };
  const handlers = {};
  const ui = new TailnetWindows({
    electron: {
      BrowserWindow: FakeWindow,
      ipcMain: {
        handle: (name, fn) => {
          handlers[name] = fn;
        },
      },
      dialog: {
        showMessageBox: async () => {
          state.prompts++;
          return { response: state.response };
        },
      },
    },
    cli: {
      profiles: async () => {
        state.reads++;
        return state.profiles;
      },
      switchTo: async () => {
        state.switches++;
      },
      verify: async () => {},
    },
    readAccounts: () => structuredClone(state.stored),
    writeAccounts: (stored) => {
      state.stored = stored;
      return true;
    },
    probe: async () => ({ ok: true }),
    connectAccount: () => {},
  });
  ui.register();
  const parent = new FakeWindow();
  return { ui, state, handlers, parent };
}

describe("local tailnet IPC boundary", () => {
  test("requires the owned window, exact packaged page, and main frame", () => {
    const window = new FakeWindow();
    window.loadFile(path.join(__dirname, "offline.html"));
    window.webContents.mainFrame.url += "?url=https%3A%2F%2Fwork.example.test";
    expect(fromLocalPage(window.event(), window, "offline.html")).toBe(true);
    expect(fromLocalPage(window.event(), window, "setup.html")).toBe(false);
    expect(
      fromLocalPage(
        { ...window.event(), senderFrame: { ...window.webContents.mainFrame } },
        window,
        "offline.html",
      ),
    ).toBe(false);
    expect(
      fromLocalPage(new FakeWindow().event(), window, "offline.html"),
    ).toBe(false);
    window.webContents.mainFrame.url = "https://work.example.test/offline.html";
    expect(fromLocalPage(window.event(), window, "offline.html")).toBe(false);
    window.webContents.mainFrame.url = "file:///tmp/offline.html";
    expect(fromLocalPage(window.event(), window, "offline.html")).toBe(false);
  });

  test("remote and unrelated windows cannot list profiles, save bindings or operate a connection", async () => {
    const { ui, state, handlers, parent } = fixture();
    ui.settings(parent, "work");
    const event = parent.event();
    expect(await handlers["os1:tailnet-settings"](event)).toBeNull();
    expect(
      await handlers["os1:tailnet-save"](event, "work", "bbbb", false),
    ).toEqual({ ok: false });
    expect(await handlers["os1:tailnet-state"](event)).toBeNull();
    await handlers["os1:tailnet-action"](event, "retry");
    expect(state.reads).toBe(0);
    expect(state.switches).toBe(0);
  });

  test("a new binding requires native confirmation, and saving never switches", async () => {
    const { ui, state, handlers, parent } = fixture();
    ui.settings(parent, "work");
    const event = ui.settingsWindow.event();
    state.response = 0;
    expect(
      (await handlers["os1:tailnet-save"](event, "work", "bbbb", false)).ok,
    ).toBe(false);
    expect(state.stored.accounts[0].tailscaleProfileId).toBeUndefined();
    state.response = 1;
    expect(
      (await handlers["os1:tailnet-save"](event, "work", "bbbb", false)).ok,
    ).toBe(true);
    expect(state.prompts).toBe(2);
    expect(state.stored.accounts[0].tailscaleProfileId).toBe("bbbb");
    expect(state.switches).toBe(0);
    await handlers["os1:tailnet-save"](event, "work", "bbbb", false);
    expect(state.prompts).toBe(2);
  });

  test("rejects unknown profiles and allows disabling without a working CLI", async () => {
    const { ui, state, handlers, parent } = fixture();
    state.stored.accounts[0].tailscaleProfileId = "bbbb";
    ui.settings(parent, "work");
    const event = ui.settingsWindow.event();
    expect(
      (await handlers["os1:tailnet-save"](event, "work", "cccc", false)).ok,
    ).toBe(false);
    expect(
      (await handlers["os1:tailnet-save"](event, "work", "--help", false)).ok,
    ).toBe(false);
    ui.cli.profiles = async () => {
      throw new Error("Not installed");
    };
    expect((await handlers["os1:tailnet-settings"](event)).error).toBe(
      "Not installed",
    );
    expect(
      (await handlers["os1:tailnet-save"](event, "work", null, false)).ok,
    ).toBe(true);
    expect(state.stored.accounts[0].tailscaleProfileId).toBeNull();
  });

  test("re-reads accounts after confirmation to preserve routes and detect removals", async () => {
    const { ui, state, parent } = fixture();
    ui.settings(parent, "work");
    ui.electron.dialog.showMessageBox = async () => {
      state.stored.accounts[0].lastUrl =
        "https://work.example.test/session/latest";
      return { response: 1 };
    };
    expect(
      (await ui.saveSettings(ui.settingsWindow.event(), "work", "bbbb", false))
        .ok,
    ).toBe(true);
    expect(state.stored.accounts[0].lastUrl).toContain("/session/latest");
    ui.electron.dialog.showMessageBox = async () => {
      state.stored.accounts = [];
      return { response: 1 };
    };
    expect(
      (await ui.saveSettings(ui.settingsWindow.event(), "work", "aaaa", false))
        .ok,
    ).toBe(false);
  });
});

describe("connection window lifetime", () => {
  test("settings cover and follow the parent without a native sheet swallowing outside clicks", () => {
    const { ui, parent } = fixture();
    ui.settings(parent, "work");
    const window = ui.settingsWindow;
    expect(window.options).toMatchObject({
      ...parent.getContentBounds(),
      parent,
      modal: false,
      frame: false,
      transparent: true,
    });
    parent.bounds = { x: 200, y: 120, width: 900, height: 700 };
    parent.emit("resize");
    expect(window.bounds).toEqual(parent.bounds);
    parent.bounds.x = 300;
    parent.emit("move");
    expect(window.bounds).toEqual(parent.bounds);
    window.close();
    expect(ui.settingsWindow).toBeNull();
    expect(parent.listenerCount("move")).toBe(0);
    expect(parent.listenerCount("resize")).toBe(0);
  });

  test("dismissing settings during confirmation neither saves nor connects", async () => {
    const { ui, state, parent, handlers } = fixture();
    ui.settings(parent, "work");
    const window = ui.settingsWindow;
    let confirm;
    ui.electron.dialog.showMessageBox = () =>
      new Promise((resolve) => {
        confirm = resolve;
      });
    let connected = false;
    ui.connectAccount = () => {
      connected = true;
    };
    const saving = ui.saveSettings(window.event(), "work", "bbbb", true);
    await Promise.resolve();
    await handlers["os1:tailnet-action"](window.event(), "close");
    confirm({ response: 1 });
    expect((await saving).ok).toBe(false);
    expect(state.stored.accounts[0].tailscaleProfileId).toBeUndefined();
    expect(connected).toBe(false);
    expect(state.switches).toBe(0);
  });

  test("save and connect waits for the settings window's asynchronous close", async () => {
    const { ui, state, parent } = fixture();
    ui.settings(parent, "work");
    const window = ui.settingsWindow;
    window.close = () => {};
    let connected = false;
    ui.connectAccount = () => {
      expect(ui.settingsWindow).toBeNull();
      connected = true;
    };
    expect(
      (await ui.saveSettings(window.event(), "work", "bbbb", true)).ok,
    ).toBe(true);
    await new Promise(setImmediate);
    expect(connected).toBe(false);
    window.destroy();
    expect(connected).toBe(true);
    expect(state.stored.accounts[0].tailscaleProfileId).toBe("bbbb");
  });

  test("choosing another profile waits for the recovery window to close", async () => {
    const { ui, state, parent, handlers } = fixture();
    const result = ui.connect(parent, {
      ...state.stored.accounts[0],
      tailscaleProfileId: "bbbb",
    });
    const window = ui.connectionWindow;
    window.close = () => {};
    await handlers["os1:tailnet-action"](window.event(), "choose");
    expect(ui.settingsWindow).toBeNull();
    window.destroy();
    expect(await result).toBe(false);
    expect(ui.settingsWindow).not.toBeNull();
    expect(ui.settingsAccountId).toBe("work");
  });

  test("paints a local window before switching and excludes competing requests", async () => {
    const { ui, state, parent } = fixture();
    const account = { ...state.stored.accounts[0], tailscaleProfileId: "bbbb" };
    const result = ui.connect(parent, account);
    expect(state.switches).toBe(0);
    expect(await ui.connect(parent, account)).toBe(false);
    expect(ui.connectionWindow.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    ui.connectionWindow.emit("ready-to-show");
    expect(await result).toBe(true);
    expect(ui.switching).toBe(false);
    expect(state.switches).toBe(1);
  });

  test("keeps the previous organization and exposes recovery when unreachable", async () => {
    const { ui, state, parent, handlers } = fixture();
    ui.probe = async () => ({ ok: false });
    const result = ui.connect(parent, {
      ...state.stored.accounts[0],
      tailscaleProfileId: "bbbb",
    });
    ui.connection.wait = async () => {};
    await ui.connection.connect();
    expect(ui.connection.snapshot().phase).toBe("error");
    expect(state.stored.activeId).toBe("work");
    await handlers["os1:tailnet-action"](ui.connectionWindow.event(), "close");
    expect(await result).toBe(false);
    expect(ui.switching).toBe(false);
  });

  test("a destroyed parent cannot free the global lock while the CLI is still running", async () => {
    const { ui, state, parent } = fixture();
    let finish;
    ui.cli.switchTo = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const result = ui.connect(parent, {
      ...state.stored.accounts[0],
      tailscaleProfileId: "bbbb",
    });
    const window = ui.connectionWindow;
    window.emit("ready-to-show");
    await Promise.resolve();
    window.close();
    expect(window.isDestroyed()).toBe(false);
    // An explicit application quit must still be possible during a CLI call.
    ui.isQuitting = () => true;
    window.close();
    expect(window.isDestroyed()).toBe(true);
    expect(await result).toBe(false);
    expect(ui.switching).toBe(true);
    finish();
    // Drain the finite promise chain; no timers or real network operations.
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(ui.switching).toBe(false);
  });
});
