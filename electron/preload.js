const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("screenshot-trigger", () => {
  window.dispatchEvent(new CustomEvent("screenshot-trigger"));
});

contextBridge.exposeInMainWorld("electronAPI", {
  chooseSaveDir: () => ipcRenderer.invoke("choose-save-dir"),
  saveScreenshot: (opts) => ipcRenderer.invoke("save-screenshot", opts),
  setWindowSize: (width, height) => ipcRenderer.invoke("set-window-size", width, height),
  getWindowSize: () => ipcRenderer.invoke("get-window-size"),
  registerScreenshotShortcut: (accelerator) => ipcRenderer.invoke("register-screenshot-shortcut", accelerator),
  platform: process.platform,
});
