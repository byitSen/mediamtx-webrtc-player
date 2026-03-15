const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  chooseSaveDir: () => ipcRenderer.invoke("choose-save-dir"),
  saveScreenshot: (opts) => ipcRenderer.invoke("save-screenshot", opts),
  setWindowSize: (width, height) => ipcRenderer.invoke("set-window-size", width, height),
  platform: process.platform,
});
