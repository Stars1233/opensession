const { contextBridge, ipcRenderer } = require("electron");

// Loaded ONLY by the packaged approval window, never by the remote web app.
contextBridge.exposeInMainWorld("onePasswordApproval", {
  request: () => ipcRenderer.invoke("os1:onepassword-review"),
  decide: (approve) => ipcRenderer.send("os1:onepassword-decision", approve),
});
