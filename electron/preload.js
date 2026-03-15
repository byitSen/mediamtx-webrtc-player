const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  chooseSaveDir: () => ipcRenderer.invoke("choose-save-dir"),
  saveScreenshot: (opts) => ipcRenderer.invoke("save-screenshot", opts),
  platform: process.platform,
});
