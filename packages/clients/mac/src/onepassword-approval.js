const path = require("node:path");
const { fromLocalPage } = require("./tailnet-ui");

// A scrollable, packaged approval sheet. Remote content has no access to these
// handlers, including same-origin assets and subframes of the trusted app.
async function showOnePasswordApproval(
  parent,
  options,
  electron = require("electron"),
) {
  const { BrowserWindow, ipcMain } = electron;
  const window = new BrowserWindow({
    parent,
    modal: true,
    width: 620,
    height: 720,
    minWidth: 440,
    minHeight: 400,
    minimizable: false,
    maximizable: false,
    show: false,
    title: "1Password request",
    webPreferences: {
      preload: path.join(__dirname, "onepassword-preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "onepassword-approval",
    },
  });
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  const trusted = (event) =>
    fromLocalPage(event, window, "onepassword-approval.html");
  ipcMain.handle("os1:onepassword-review", (event) =>
    trusted(event)
      ? {
          message: options.message,
          detail: options.detail,
        }
      : null,
  );
  return new Promise((resolve) => {
    let response = 0;
    const decide = (event, approve) => {
      if (!trusted(event) || typeof approve !== "boolean") return;
      response = approve ? 1 : 0;
      window.close();
    };
    ipcMain.on("os1:onepassword-decision", decide);
    window.once("closed", () => {
      ipcMain.removeHandler("os1:onepassword-review");
      ipcMain.removeListener("os1:onepassword-decision", decide);
      resolve({ response });
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window
      .loadFile(path.join(__dirname, "onepassword-approval.html"))
      .catch(() => window.close());
  });
}

module.exports = { showOnePasswordApproval };
