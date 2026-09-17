const { expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { showOnePasswordApproval } = require("./onepassword-approval");

test("only the owned packaged main frame can see or approve a request", async () => {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  let window;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {
        url: pathToFileURL(path.join(__dirname, "onepassword-approval.html"))
          .href,
      };
      this.webContents.session = {
        setPermissionRequestHandler: (h) => {
          this.permission = h;
        },
      };
      this.webContents.setWindowOpenHandler = (h) => {
        this.open = h;
      };
    }
    isDestroyed() {
      return false;
    }
    loadFile() {
      return Promise.resolve();
    }
    show() {}
    close() {
      this.emit("closed");
    }
  }
  const result = showOnePasswordApproval(
    {},
    { message: "Review", detail: "one field" },
    { BrowserWindow: Window, ipcMain },
  );
  const good = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const read = handlers.get("os1:onepassword-review");
  expect(read(good)).toEqual({ message: "Review", detail: "one field" });
  for (const bad of [
    { sender: {}, senderFrame: good.senderFrame },
    { sender: good.sender, senderFrame: { url: good.senderFrame.url } },
  ]) {
    expect(read(bad)).toBeNull();
    ipcMain.emit("os1:onepassword-decision", bad, true);
    expect(handlers.has("os1:onepassword-review")).toBe(true);
  }
  good.senderFrame.url = "https://os.example.com/session/test";
  expect(read(good)).toBeNull();
  ipcMain.emit("os1:onepassword-decision", good, true);
  expect(handlers.has("os1:onepassword-review")).toBe(true);
  good.senderFrame.url = pathToFileURL(
    path.join(__dirname, "onepassword-approval.html"),
  ).href;
  expect(window.open()).toEqual({ action: "deny" });
  let allowed;
  window.permission(null, "clipboard-read", (value) => {
    allowed = value;
  });
  expect(allowed).toBe(false);
  expect(window.options.webPreferences.sandbox).toBe(true);
  expect(window.options.webPreferences.contextIsolation).toBe(true);
  expect(window.options.webPreferences.nodeIntegration).toBe(false);
  ipcMain.emit("os1:onepassword-decision", good, true);
  expect(await result).toEqual({ response: 1 });
  expect(handlers.size).toBe(0);
  expect(ipcMain.listenerCount("os1:onepassword-decision")).toBe(0);
});
