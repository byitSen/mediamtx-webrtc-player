const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("screenshot-trigger", () => {
  window.dispatchEvent(new CustomEvent("screenshot-trigger"));
});

ipcRenderer.on("memory-watch-log", (_, entry) => {
  window.dispatchEvent(new CustomEvent("memory-watch-log", { detail: entry }));
});

contextBridge.exposeInMainWorld("electronAPI", {
  chooseSaveDir: () => ipcRenderer.invoke("choose-save-dir"),
  saveScreenshot: (opts) => ipcRenderer.invoke("save-screenshot", opts),
  setWindowSize: (width, height) => ipcRenderer.invoke("set-window-size", width, height),
  getWindowSize: () => ipcRenderer.invoke("get-window-size"),
  registerScreenshotShortcut: (accelerator) => ipcRenderer.invoke("register-screenshot-shortcut", accelerator),
  configureMemoryWatch: (cfg) => ipcRenderer.invoke("configure-memory-watch", cfg),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  createRtspProxy: (rtspUrl) => ipcRenderer.invoke("rtsp-proxy:create", rtspUrl),
  destroyRtspProxy: (rtspUrl) => ipcRenderer.invoke("rtsp-proxy:destroy", rtspUrl),
  destroyAllRtspProxies: () => ipcRenderer.invoke("rtsp-proxy:destroy-all"),
  platform: process.platform,
});
