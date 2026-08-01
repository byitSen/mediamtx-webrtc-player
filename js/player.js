import { formatTimestamp, saveImageToPath } from "./utils.js";
import { RtspMsePlayer, pickMseCodec } from "./rtsp-mse-player.js";

function isDesktop() {
  return typeof window !== "undefined" && !!(window.desktopAPI?.isDesktop?.() || window.electronAPI);
}

function cameraId(camera) {
  return camera?.rtspUrl || camera?.path || camera?.id || camera?.name || "";
}

/** 当前处于画面全屏 UI 的 Player 实例 */
const activeFullscreenPlayers = new Set();

export class Player {
  constructor(containerEl, cameraConfig) {
    this.containerEl = containerEl;
    this.camera = cameraConfig;
    this.msePlayer = null;
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

    const video = document.createElement("video");
    video.className = "player-video";
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("disablepictureinpicture", "");
    video.setAttribute("controlslist", "nodownload nofullscreen noremoteplayback");

    videoWrapper.appendChild(video);

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
      video,
      btnFull,
      btnReconnect,
      statsText,
    };
  }

  _updateVideoWrapperAspectRatio() {
    const { video, videoWrapper } = this.dom;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w > 0 && h > 0) {
      videoWrapper.style.aspectRatio = `${w} / ${h}`;
    } else {
      videoWrapper.style.aspectRatio = "";
    }
  }

  _bindEvents() {
    const enterFullscreen = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      void this.toggleFullscreenInApp();
    };
    this.dom.btnFull.addEventListener("click", (e) => enterFullscreen(e));
    // capture：阻止 <video> 原生全屏抢占双击
    this.dom.videoWrapper.addEventListener("dblclick", enterFullscreen, true);
    this.dom.video.addEventListener("dblclick", enterFullscreen, true);
    this.dom.btnReconnect.addEventListener("click", () => this.reconnectNow());
    this.dom.video.addEventListener("loadedmetadata", () => this._updateVideoWrapperAspectRatio());
    this.dom.video.addEventListener("resize", () => this._updateVideoWrapperAspectRatio());
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

    if (!isDesktop() || !window.electronAPI?.createRtspProxy) {
      this.setStatus("not_ready", "仅桌面版支持本地 RTSP");
      this.dom.status.title = "请使用 Tauri 桌面版播放 RTSP";
      this.dom.statsText.textContent = "请使用桌面版";
      return;
    }

    const mime = pickMseCodec();
    if (!mime) {
      this.setStatus("not_ready", "不支持 MSE 解码");
      this.dom.status.title = "H.265 可能需安装系统 HEVC 扩展";
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

      this.msePlayer = new RtspMsePlayer(this.dom.video, {
        onStatus: (s) => {
          if (s === "online") {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.setStatus("online");
            this.dom.statsText.textContent = "播放中…";
            this._updateVideoWrapperAspectRatio();
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
          this.setStatus("not_ready", msg || "播放失败");
          this.dom.status.title = msg || "";
        },
        onStats: ({ fps }) => {
          this.dom.statsText.textContent = `FPS: ${fps != null ? fps.toFixed(1) : "-"}`;
        },
      });

      await this.msePlayer.play(wsUrl, mime);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[${this.camera.name || rtspUrl}] RTSP 错误:`, msg);
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

  /** 仅退出画面全屏 UI，不改动主窗口尺寸（保持屏幕全屏） */
  _exitFullscreenUiOnly() {
    const card = this.containerEl;
    const media = this.dom.video;
    if (!card?.classList.contains("fullscreen-mode") && !this._fullscreenPlaceholder) {
      activeFullscreenPlayers.delete(this);
      return;
    }
    card.classList.remove("fullscreen-mode");
    card.style.cursor = "";
    if (this._fullscreenPlaceholder?.parentNode) {
      this._fullscreenPlaceholder.parentNode.insertBefore(card, this._fullscreenPlaceholder);
      this._fullscreenPlaceholder.remove();
    }
    this._fullscreenPlaceholder = null;
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
    this._fullscreenDragging = false;
    this._fullscreenDragStart = null;
    activeFullscreenPlayers.delete(this);

    if (activeFullscreenPlayers.size === 0) {
      document.body.classList.remove("app-player-fullscreen");
      document.documentElement.style.removeProperty("--app-top-bar-height");
      document.body.style.overflow = "";
    }
  }

  async toggleFullscreenInApp() {
    const card = this.containerEl;
    const isFull = card.classList.contains("fullscreen-mode");
    const api = typeof window !== "undefined" && window.electronAPI;

    if (isFull) {
      // 画面退出全屏：主窗口保持当前屏幕尺寸，不缩回启动尺寸
      this._exitFullscreenUiOnly();
      this._savedWindowSize = null;
      return;
    }

    // 先干净退出其他画面的全屏 UI（不改窗口大小）
    for (const other of [...activeFullscreenPlayers]) {
      if (other !== this) other._exitFullscreenUiOnly();
    }

    if (!this._fullscreenPlaceholder) {
      this._fullscreenPlaceholder = document.createComment("player-fullscreen-anchor");
      card.parentNode?.insertBefore(this._fullscreenPlaceholder, card);
      document.body.appendChild(card);
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
    document.body.classList.add("app-player-fullscreen");
    document.body.style.overflow = "hidden";
    activeFullscreenPlayers.add(this);

    const topBar = document.querySelector(".top-bar");
    const topH = topBar ? Math.ceil(topBar.getBoundingClientRect().height) : 52;
    document.documentElement.style.setProperty("--app-top-bar-height", `${topH}px`);

    // 主窗口铺满当前显示器；退出画面全屏后仍保持该尺寸
    if (api?.setWindowSize) {
      try {
        let fw = 0;
        let fh = 0;
        let sx = null;
        let sy = null;
        if (api.getScreenSize) {
          const screen = await api.getScreenSize();
          if (screen?.width && screen?.height) {
            fw = screen.width;
            fh = screen.height;
            if (typeof screen.x === "number") sx = screen.x;
            if (typeof screen.y === "number") sy = screen.y;
          }
        }
        if (!fw || !fh) {
          fw = Math.max(520, window.screen?.availWidth || window.screen?.width || 1920);
          fh = Math.max(420, window.screen?.availHeight || window.screen?.height || 1080);
        }
        if (api.setWindowPosition && sx != null && sy != null) {
          try {
            await api.setWindowPosition(sx, sy);
          } catch (_) {}
        }
        await api.setWindowSize(fw, fh);
      } catch (e) {
        console.warn("set fullscreen window size:", e);
      }
    }
  }

  _applyFullscreenTransform() {
    if (!this.dom.video) return;
    const { x, y } = this.fullscreenPan || { x: 0, y: 0 };
    this.dom.video.style.transform = `translate(${x}px, ${y}px) scale(${this.fullscreenZoom})`;
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
    const video = this.dom.video;
    if (!video || !video.videoWidth) return;
    const ts = batchTimestamp || Date.now();
    const { date, time } = formatTimestamp(ts);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
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
    if (this.msePlayer) {
      try {
        this.msePlayer.destroy();
      } catch (_) {}
      this.msePlayer = null;
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
    if (this.containerEl?.classList.contains("fullscreen-mode") || this._fullscreenPlaceholder) {
      try {
        this._exitFullscreenUiOnly();
      } catch (_) {
        activeFullscreenPlayers.delete(this);
        this._fullscreenPlaceholder = null;
      }
    }
    this.clearReconnectTimer();
    this.stopStatsTimer();
    void this.closePeer();
    this.containerEl.innerHTML = "";
  }
}
