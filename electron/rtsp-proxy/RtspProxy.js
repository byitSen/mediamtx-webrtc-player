const { spawn } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { app } = require("electron");

class RtspProxy {
  /**
   * @param {string} rtspUrl
   * @param {number} port
   */
  constructor(rtspUrl, port) {
    this.rtspUrl = rtspUrl;
    this.port = port;
    this.ffmpeg = null;
    this.wss = null;
    this.clients = new Set();
    this.isRunning = false;
    this.wsUrl = null;
    this._killTimer = null;
  }

  async start() {
    if (this.isRunning) return this.wsUrl;
    await this._startWebSocket();
    this._startFfmpeg();
    this.isRunning = true;
    this.wsUrl = `ws://127.0.0.1:${this.port}`;
    return this.wsUrl;
  }

  stop() {
    this.isRunning = false;

    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }

    this.clients.forEach((ws) => {
      try {
        ws.close();
      } catch (_) {}
    });
    this.clients.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch (_) {}
      this.wss = null;
    }

    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;
      try {
        proc.kill("SIGINT");
      } catch (_) {}
      this._killTimer = setTimeout(() => {
        try {
          if (proc.exitCode === null && !proc.killed) {
            proc.kill("SIGKILL");
          }
        } catch (_) {}
      }, 1000);
    }
  }

  _startWebSocket() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });
      this.wss = wss;

      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        wss.off("listening", onListening);
        wss.off("error", onError);
      };

      wss.on("listening", onListening);
      wss.on("error", onError);

      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        ws.on("error", () => this.clients.delete(ws));
      });
    });
  }

  _startFfmpeg() {
    const ffmpegPath = this._getFfmpegPath();
    if (!fs.existsSync(ffmpegPath)) {
      throw new Error(`未找到 FFmpeg: ${ffmpegPath}（请先运行 npm run download-ffmpeg）`);
    }

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-i",
      this.rtspUrl,
      "-an",
      "-vcodec",
      "copy",
      "-f",
      "hevc",
      "-",
    ];

    this.ffmpeg = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.ffmpeg.stdout.on("data", (chunk) => {
      if (!this.isRunning || this.clients.size === 0) return;
      this.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(chunk);
          } catch (_) {}
        }
      });
    });

    this.ffmpeg.stderr.on("data", (buf) => {
      const msg = buf.toString().trim();
      if (msg) console.warn(`[RtspProxy] ffmpeg: ${msg.slice(0, 300)}`);
    });

    this.ffmpeg.on("close", () => {
      this.isRunning = false;
    });

    this.ffmpeg.on("error", (err) => {
      console.error("[RtspProxy] FFmpeg 进程异常:", err.message);
      this.isRunning = false;
    });
  }

  _getFfmpegPath() {
    const platform = os.platform();
    const osDir = platform === "win32" ? "win" : platform === "darwin" ? "mac" : platform === "linux" ? "linux" : null;
    if (!osDir) throw new Error(`不支持的平台: ${platform}`);

    const basePath = app.isPackaged
      ? path.join(process.resourcesPath, "ffmpeg")
      : path.join(__dirname, "..", "..", "resources", "ffmpeg");

    const binary = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    return path.join(basePath, osDir, binary);
  }
}

module.exports = RtspProxy;
