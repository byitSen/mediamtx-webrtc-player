const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");

// Chromium 136+ WebRTC H.265：启用解码并在 SDP 中协商 H.265，便于直接播 H.265 源
app.commandLine.appendSwitch("enable-features", "HevcVideoDecoder,WebRtcAllowH265Receive,WebRtcAllowH265Send");

// 设置安全的 Content-Security-Policy，消除 Electron 安全警告（禁止 unsafe-eval）
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' http: https: wss:",
  "media-src 'self' blob:",
  "img-src 'self' data: blob:",
].join("; ");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: "MediaMTX WebRTC 多窗口摄像头播放器",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = process.env.NODE_ENV === "development" || process.defaultApp;
  if (isDev) {
    mainWindow.loadURL("http://localhost:8000");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});

ipcMain.handle("choose-save-dir", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths?.length) return null;
  return filePaths[0];
});

ipcMain.handle("save-screenshot", async (_, { baseDir, relativePath, base64Png }) => {
  if (!baseDir || !relativePath || !base64Png) return { err: "missing args" };
  if (relativePath.includes("..") || path.isAbsolute(relativePath)) return { err: "invalid path" };
  const fs = require("fs");
  const fullPath = path.join(baseDir, relativePath);
  const dir = path.dirname(fullPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(base64Png, "base64");
    fs.writeFileSync(fullPath, buf);
    return { ok: true };
  } catch (e) {
    return { err: e.message };
  }
});
