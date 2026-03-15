const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

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

// 开发/解包时 __dirname 为 electron/，打包后可能为 app.asar/electron，需取到应用根目录
const APP_ROOT = path.resolve(path.join(__dirname, ".."));
const MIMES = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".ico": "image/x-icon" };

/** 非 dev 时用本地 HTTP 服务加载前端，避免 file:// 下 ES modules 无法加载导致白屏 */
function createStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
        urlPath = decodeURIComponent(urlPath);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const safePath = path.normalize(urlPath.replace(/^\//, "")).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.resolve(path.join(APP_ROOT, safePath));
      const rootNormalized = path.resolve(APP_ROOT) + path.sep;
      if (filePath !== APP_ROOT && !filePath.startsWith(rootNormalized)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const ext = path.extname(filePath);
      const mime = MIMES[ext] || "application/octet-stream";
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

let mainWindow = null;
let staticServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 820,
    minWidth: 520,
    minHeight: 420,
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
    // 用本地 HTTP 服务加载，避免 file:// 下 ES modules 被阻止导致白屏
    createStaticServer().then(({ server, url }) => {
      staticServer = server;
      mainWindow.loadURL(url);
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (staticServer) {
      staticServer.close();
      staticServer = null;
    }
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

const WINDOW_WIDTH_MIN = 520;
const WINDOW_WIDTH_MAX = 3840;
const WINDOW_HEIGHT_MIN = 420;
const WINDOW_HEIGHT_MAX = 2160;

ipcMain.handle("set-window-size", (_, width, height) => {
  const w = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(width, 10) || 1020));
  const h = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(height, 10) || 820));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSize(w, h);
  }
});
