import { getEffectiveSettings } from "./config.js";
import { formatTimestamp, saveImageToPath } from "./utils.js";
import { H265Player } from "./h265-player.js";

function isElectron() {
  return typeof window !== "undefined" && !!window.electronAPI;
}

function cameraId(camera) {
  return camera?.rtspUrl || camera?.path || camera?.id || camera?.name || "";
}

export class Player {
  constructor(containerEl, cameraConfig) {
    this.containerEl = containerEl;
    this.camera = cameraConfig;
    this.h265 = null;
    this.proxyRtspUrl = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.statsTimer = null;
    this._buildDom();
    this._bindEvents();
  }

  _buildDom() {
    this.containerEl.classList.add("player-card");

    const header = document.createElement("div");
    header.className = "player-header";

    const title = document.createElement("div");
    title.className = "player-title";
    title.textContent = this.camera.name || cameraId(this.camera) || "未命名摄像头";

    const status = document.createElement("div");
    status.className = "player-status offline";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const text = document.createElement("span");
    text.className = "status-text";
    text.textContent = "未连接";
    status.appendChild(dot);
    status.appendChild(text);

    header.appendChild(title);
    header.appendChild(status);

    const videoWrapper = document.createElement("div");
    videoWrapper.className = "video-wrapper";

    const canvas = document.createElement("canvas");
    canvas.className = "player-video player-canvas";

    videoWrapper.appendChild(canvas);

    const footer = document.createElement("div");
    footer.className = "player-footer";

    const left = document.createElement("div");
    left.className = "player-footer-left";
    const btnFull = document.createElement("button");
    btnFull.className = "btn btn-sm secondary";
    btnFull.textContent = "全屏";
    left.appendChild(btnFull);

    const right = document.createElement("div");
    right.className = "player-footer-right";
    const btnReconnect = document.createElement("button");
    btnReconnect.className = "btn btn-sm secondary";
    btnReconnect.textContent = "重连";

    const statsText = document.createElement("span");
    statsText.className = "stats-text";
    statsText.textContent = "未连接";

    right.appendChild(statsText);
    right.appendChild(btnReconnect);

    footer.appendChild(left);
    footer.appendChild(right);

    this.containerEl.appendChild(header);
    this.containerEl.appendChild(videoWrapper);
    this.containerEl.appendChild(footer);

    this.dom = {
      header,
      status,
      statusText: text,
      videoWrapper,
      canvas,
      video: canvas,
      btnFull,
      btnReconnect,
      statsText,
    };
  }

  _updateVideoWrapperAspectRatio(w, h) {
    const { videoWrapper } = this.dom;
    if (w > 0 && h > 0) {
      videoWrapper.style.aspectRatio = `${w} / ${h}`;
    } else {
      videoWrapper.style.aspectRatio = "";
    }
  }

  _bindEvents() {
    this.dom.btnFull.addEventListener("click", () => {
      this.toggleFullscreenInApp();
    });

    this.dom.videoWrapper.addEventListener("dblclick", () => {
      this.toggleFullscreenInApp();
    });

    this.dom.btnReconnect.addEventListener("click", () => {
      this.reconnectNow();
    });
  }

  setStatus(state, subText) {
    this.dom.status.classList.remove("online", "offline", "connecting", "not-ready");
    this.dom.status.title = "";
    if (state === "online") {
      this.dom.status.classList.add("online");
      this.dom.statusText.textContent = "已连接";
      this.isConnected = true;
    } else if (state === "connecting") {
      this.dom.status.classList.add("connecting");
      this.dom.statusText.textContent = "连接中...";
      this.isConnected = false;
    } else if (state === "not_ready") {
      this.dom.status.classList.add("not-ready");
      this.dom.statusText.textContent = subText || "流未就绪";
      this.isConnected = false;
    } else {
      this.dom.status.classList.add("offline");
      this.dom.statusText.textContent = subText || "未连接";
      this.isConnected = false;
    }
  }

  async connect() {
    this.clearReconnectTimer();
    this.stopStatsTimer();
    await this.closePeer();

    if (!isElectron() || !window.electronAPI?.createRtspProxy) {
      this.setStatus("not_ready", "仅桌面版支持本地 RTSP");
      this.dom.status.title = "请使用 Electron 桌面版播放 RTSP";
      this.dom.statsText.textContent = "请使用桌面版";
      return;
    }

    const rtspUrl = (this.camera.rtspUrl || "").trim();
    if (!rtspUrl) {
      this.setStatus("not_ready", "未配置 RTSP 地址");
      return;
    }

    this.setStatus("connecting");
    this.isConnected = false;

    try {
      const res = await window.electronAPI.createRtspProxy(rtspUrl);
      if (!res?.success || !res.data) {
        throw new Error(res?.message || "创建 RTSP 代理失败");
      }
      this.proxyRtspUrl = rtspUrl;
      const wsUrl = res.data;
      const cfg = getEffectiveSettings();
      const lockFpsEnabled = cfg.lockFpsEnabled !== false;
      const lockFps = Math.max(1, Math.min(60, parseInt(cfg.lockFps, 10) || 25));

      this.h265 = new H265Player(this.dom.canvas, {
        lockFpsEnabled,
        lockFps,
        onStatus: (s) => {
          if (s === "online") {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.setStatus("online");
            this.dom.statsText.textContent = lockFpsEnabled ? `解码中…（锁 ${lockFps}fps）` : "解码中…";
          } else if (s === "connecting") {
            this.setStatus("connecting");
          } else if (s === "offline") {
            this.isConnected = false;
            this.setStatus("offline");
            this.reconnectAttempts += 1;
            const delay = Math.min(5000 + this.reconnectAttempts * 3000, 25000);
            this.scheduleReconnect(delay);
          }
        },
        onError: (msg) => {
          this.setStatus("not_ready", msg || "解码失败");
          this.dom.status.title = msg || "";
        },
        onFrame: ({ width, height }) => this._updateVideoWrapperAspectRatio(width, height),
        onStats: ({ fps, lockFpsEnabled: locked, lockFps: target }) => {
          const rate = fps ? fps.toFixed(1) : "-";
          this.dom.statsText.textContent = locked ? `FPS: ${rate}（锁 ${target}）` : `FPS: ${rate}`;
        },
      });

      await this.h265.play(wsUrl);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[${this.camera.name || rtspUrl}] RTSP 代理错误:`, msg);
      this.setStatus("offline", msg);
      this.reconnectAttempts += 1;
      const delay = Math.min(3000 + this.reconnectAttempts * 2000, 20000);
      this.scheduleReconnect(delay);
    }
  }

  scheduleReconnect(delayMs = 2000) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  reconnectNow() {
    this.clearReconnectTimer();
    this.connect();
  }

  stopStatsTimer() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  async toggleFullscreenInApp() {
    const card = this.containerEl;
    const isFull = card.classList.contains("fullscreen-mode");
    const media = this.dom.canvas;
    const api = typeof window !== "undefined" && window.electronAPI;

    if (isFull) {
      card.classList.remove("fullscreen-mode");
      document.body.style.overflow = "";
      card.style.cursor = "";
      if (this._fullscreenWheelHandler) {
        card.removeEventListener("wheel", this._fullscreenWheelHandler, { passive: false });
        this._fullscreenWheelHandler = null;
      }
      if (this._fullscreenDragHandlers) {
        card.removeEventListener("mousedown", this._fullscreenDragHandlers.down);
        document.removeEventListener("mousemove", this._fullscreenDragHandlers.move);
        document.removeEventListener("mouseup", this._fullscreenDragHandlers.up);
        document.removeEventListener("mouseleave", this._fullscreenDragHandlers.leave);
        this._fullscreenDragHandlers = null;
      }
      if (media) media.style.transform = "";
      this.fullscreenZoom = 1;
      this.fullscreenPan = { x: 0, y: 0 };
      if (api?.setWindowSize && this._savedWindowSize) {
        const { width, height } = this._savedWindowSize;
        api.setWindowSize(width, height);
        this._savedWindowSize = null;
      }
    } else {
      if (api?.getWindowSize && api.setWindowSize) {
        const size = await api.getWindowSize();
        if (size) {
          this._savedWindowSize = { width: size.width, height: size.height };
          const cfg = getEffectiveSettings();
          const fw = Math.max(520, Math.min(3840, cfg.fullscreenWidth ?? 1240));
          const fh = Math.max(420, Math.min(2160, cfg.fullscreenHeight ?? 800));
          api.setWindowSize(fw, fh);
        }
      }
      this.fullscreenZoom = 1;
      this.fullscreenPan = { x: 0, y: 0 };
      this._fullscreenWheelHandler = (e) => this._onFullscreenWheel(e);
      card.addEventListener("wheel", this._fullscreenWheelHandler, { passive: false });
      this._fullscreenDragHandlers = {
        down: (e) => this._onFullscreenDragStart(e),
        move: (e) => this._onFullscreenDragMove(e),
        up: () => this._onFullscreenDragEnd(),
        leave: (e) => {
          if (e.target === document) this._onFullscreenDragEnd();
        },
      };
      card.addEventListener("mousedown", this._fullscreenDragHandlers.down);
      document.addEventListener("mousemove", this._fullscreenDragHandlers.move);
      document.addEventListener("mouseup", this._fullscreenDragHandlers.up);
      document.addEventListener("mouseleave", this._fullscreenDragHandlers.leave);
      card.style.cursor = "grab";
      this._applyFullscreenTransform();
      card.classList.add("fullscreen-mode");
      document.body.style.overflow = "hidden";
    }
  }

  _applyFullscreenTransform() {
    if (!this.dom.canvas) return;
    const { x, y } = this.fullscreenPan || { x: 0, y: 0 };
    this.dom.canvas.style.transform = `translate(${x}px, ${y}px) scale(${this.fullscreenZoom})`;
  }

  _onFullscreenWheel(e) {
    if (!this.containerEl.classList.contains("fullscreen-mode")) return;
    e.preventDefault();
    const step = 0.12;
    const next = this.fullscreenZoom + (e.deltaY > 0 ? -step : step);
    this.fullscreenZoom = Math.max(0.5, Math.min(3, next));
    this._applyFullscreenTransform();
  }

  _onFullscreenDragStart(e) {
    if (!this.containerEl.classList.contains("fullscreen-mode") || e.button !== 0) return;
    this._fullscreenDragging = true;
    this._fullscreenDragStart = {
      x: e.clientX,
      y: e.clientY,
      panX: this.fullscreenPan.x,
      panY: this.fullscreenPan.y,
    };
    this.containerEl.style.cursor = "grabbing";
  }

  _onFullscreenDragMove(e) {
    if (!this._fullscreenDragging || !this._fullscreenDragStart) return;
    this.fullscreenPan.x = this._fullscreenDragStart.panX + (e.clientX - this._fullscreenDragStart.x);
    this.fullscreenPan.y = this._fullscreenDragStart.panY + (e.clientY - this._fullscreenDragStart.y);
    this._applyFullscreenTransform();
  }

  _onFullscreenDragEnd() {
    this._fullscreenDragging = false;
    this._fullscreenDragStart = null;
    if (this.containerEl.classList.contains("fullscreen-mode")) {
      this.containerEl.style.cursor = "grab";
    }
  }

  async singleScreenshot(batchTimestamp) {
    const canvas = this.dom.canvas;
    if (!canvas || !canvas.width || !canvas.height) return;
    const ts = batchTimestamp || Date.now();
    const { date, time } = formatTimestamp(ts);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    const dir = `${date}/${time}`;
    const fileName = `${this.camera.name || cameraId(this.camera)}_${ts}.jpg`;
    const fullPath = `${dir}/${fileName}`;

    if (window.electronAPI) {
      return { relativePath: fullPath, dataUrl };
    }
    await saveImageToPath(fullPath, dataUrl);
  }

  async closePeer() {
    if (this.h265) {
      try {
        this.h265.destroy();
      } catch (_) {}
      this.h265 = null;
    }
    if (this.proxyRtspUrl && window.electronAPI?.destroyRtspProxy) {
      try {
        await window.electronAPI.destroyRtspProxy(this.proxyRtspUrl);
      } catch (_) {}
      this.proxyRtspUrl = null;
    }
    this.isConnected = false;
  }

  destroy() {
    this.clearReconnectTimer();
    this.stopStatsTimer();
    void this.closePeer();
    this.containerEl.innerHTML = "";
  }
}
