/**
 * go2rtc WebSocket MSE → <video>
 *
 * MSE 逻辑对齐官方 VideoRTC.onmse()：
 * https://github.com/AlexxIT/go2rtc/blob/master/www/video-rtc.js
 *
 * 协议见：https://github.com/AlexxIT/go2rtc/blob/master/internal/api/ws/README.md
 */
const MSE_VIDEO_H265 = [
  "hvc1.1.6.L153.B0",
  "hvc1.1.6.L123.B0",
  "hvc1.1.6.L93.B0",
  "hev1.1.6.L93.B0",
];
const MSE_VIDEO_H264 = [
  "avc1.640033",
  "avc1.64002A",
  "avc1.640029",
  "avc1.640028",
  "avc1.4D401F",
  "avc1.42E01E",
];
const MSE_AUDIO = ["mp4a.40.2", "mp4a.40.5", "flac", "opus"];

/** 官方 VideoRTC 保留约 5 秒缓冲 */
const LIVE_KEEP_SEC = 5;
const PENDING_BYTES = 2 * 1024 * 1024;

function getMediaSourceCtor() {
  if (typeof ManagedMediaSource !== "undefined") return ManagedMediaSource;
  if (typeof MediaSource !== "undefined") return MediaSource;
  return null;
}

function supportedCodecList(isTypeSupported, preferredVideoCodec = "h265", videoOnly = true) {
  const preferH264 = String(preferredVideoCodec).toLowerCase() === "h264";
  const video = (preferH264 ? MSE_VIDEO_H264 : MSE_VIDEO_H265).filter((c) => {
    try {
      return isTypeSupported(`video/mp4; codecs="${c}"`);
    } catch (_) {
      return false;
    }
  });
  if (!video.length) return "";
  if (videoOnly) return video.join(",");
  const audio = MSE_AUDIO.filter((c) => {
    try {
      return isTypeSupported(`video/mp4; codecs="${c}"`);
    } catch (_) {
      return false;
    }
  });
  return [...video, ...audio].join(",");
}

function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer || data);
}

export class Go2rtcMsePlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onStatus?: Function, onError?: Function, onStats?: Function }} hooks
   */
  constructor(video, hooks = {}) {
    this.video = video;
    this.hooks = hooks;
    this.ws = null;
    this.ms = null;
    this.sb = null;
    this.objectUrl = null;
    this.destroyed = false;
    this._mime = "";
    /** @type {Uint8Array} */
    this._buf = new Uint8Array(PENDING_BYTES);
    this._bufLen = 0;
    this._statsTimer = null;
    this._lastFrames = 0;
    this._lastDropped = 0;
    this._lastStatsAt = 0;
    this._onMessage = null;
    this._onVisibility = null;
    this._pausedForHidden = false;
  }

  /**
   * @param {string} wsUrl e.g. ws://127.0.0.1:1984/api/ws?src=cam_xxx
   * @param {{ preferredVideoCodec?: "h265"|"h264", videoOnly?: boolean }} [opts]
   */
  async play(wsUrl, opts = {}) {
    this.destroyMediaOnly();
    this.destroyed = false;
    this._emitStatus("connecting");

    const MS = getMediaSourceCtor();
    if (!MS) {
      throw new Error("当前环境不支持 MediaSource / ManagedMediaSource");
    }

    const prefer = opts.preferredVideoCodec === "h264" ? "h264" : "h265";
    const videoOnly = opts.videoOnly !== false;
    const codecs = supportedCodecList(MS.isTypeSupported.bind(MS), prefer, videoOnly);
    if (!codecs) {
      throw new Error(
        prefer === "h265"
          ? "当前环境不支持 H.265 MSE（可在设置中改选 H.264，或安装 HEVC 扩展）"
          : "当前环境不支持 H.264 MSE"
      );
    }
    console.info(`[mse] VideoRTC 对齐 | ${prefer}${videoOnly ? " video-only" : ""} → ${codecs}`);

    this._bindVisibility();

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      ws.addEventListener("error", () => fail(new Error("MSE WebSocket 连接失败")));
      ws.addEventListener("close", () => {
        if (this.destroyed || settled) return;
        this._emitStatus("offline");
        this._emitError("MSE 连接已关闭");
      });

      this._onMessage = (ev) => {
        if (this.destroyed) return;
        if (typeof ev.data === "string") {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch (_) {
            return;
          }
          if (msg.type === "error") {
            fail(new Error(msg.value || "go2rtc MSE 错误"));
            return;
          }
          if (msg.type === "mse" && msg.value) {
            try {
              this._mime = msg.value;
              this._setupSourceBuffer(msg.value);
              this._emitStatus("online");
              this._startStats();
              ok();
            } catch (e) {
              fail(e);
            }
          }
          return;
        }
        this._onBinary(ev.data);
      };
      ws.addEventListener("message", this._onMessage);

      ws.addEventListener("open", () => {
        try {
          this.ms = new MS();
          const useManaged =
            typeof ManagedMediaSource !== "undefined" && this.ms instanceof ManagedMediaSource;

          this.ms.addEventListener(
            "sourceopen",
            () => {
              try {
                if (this.objectUrl) {
                  URL.revokeObjectURL(this.objectUrl);
                  this.objectUrl = null;
                }
                this._send({ type: "mse", value: codecs });
              } catch (e) {
                fail(e);
              }
            },
            { once: true }
          );

          if (useManaged) {
            this.video.disableRemotePlayback = true;
            this.video.srcObject = this.ms;
          } else {
            this.objectUrl = URL.createObjectURL(this.ms);
            this.video.srcObject = null;
            this.video.src = this.objectUrl;
          }
          this.video.muted = true;
          this.video.playsInline = true;
          this.video.autoplay = true;
          this.video.preload = "auto";
          this.video.play().catch(() => {});
        } catch (e) {
          fail(e);
        }
      });
    });
  }

  /**
   * 官方 VideoRTC.onmse 的 SourceBuffer + updateend + 追帧
   */
  _setupSourceBuffer(mime) {
    const ms = this.ms;
    const sb = ms.addSourceBuffer(mime);
    // 官方注释：segments or sequence —— 默认用 segments
    sb.mode = "segments";
    this.sb = sb;
    this._bufLen = 0;

    sb.addEventListener("updateend", () => {
      if (this.destroyed || !this.sb) return;

      // 1) 优先把积压分片 append 完
      if (!sb.updating && this._bufLen > 0) {
        try {
          const data = this._buf.slice(0, this._bufLen);
          sb.appendBuffer(data);
          this._bufLen = 0;
        } catch (_) {}
        return;
      }

      // 2) 官方追帧：保留 5s、必要时拉回、用 playbackRate ≈ gap
      if (!sb.updating && sb.buffered && sb.buffered.length) {
        try {
          const end = sb.buffered.end(sb.buffered.length - 1);
          const start = end - LIVE_KEEP_SEC;
          const start0 = sb.buffered.start(0);
          if (start > start0) {
            sb.remove(start0, start);
            try {
              ms.setLiveSeekableRange?.(start, end);
            } catch (_) {}
            return; // remove 会再触发 updateend
          }
          if (this.video.currentTime < start) {
            this.video.currentTime = start;
          }
          const gap = end - this.video.currentTime;
          // 官方原式：有缓冲就按 gap 倍速，贴边则降到 0.1
          this.video.playbackRate = gap > 0.1 ? gap : 0.1;
        } catch (_) {}
      }
    });
  }

  /** 官方 ondata：SB 忙或已有积压则拼进 buf，否则直接 append */
  _onBinary(data) {
    if (this.destroyed || !this.sb) return;
    const sb = this.sb;
    if (sb.updating || this._bufLen > 0) {
      const b = toU8(data);
      if (this._bufLen + b.byteLength > this._buf.byteLength) {
        // 极端积压：丢掉最旧 pending，保住直播边（官方未处理溢出，这里兜底）
        this._bufLen = 0;
      }
      if (this._bufLen + b.byteLength <= this._buf.byteLength) {
        this._buf.set(b, this._bufLen);
        this._bufLen += b.byteLength;
      }
    } else {
      try {
        sb.appendBuffer(data);
      } catch (_) {}
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _bindVisibility() {
    this._unbindVisibility();
    this._onVisibility = () => {
      if (this.destroyed) return;
      if (document.hidden) {
        this._pausedForHidden = true;
        try {
          this.video.pause();
        } catch (_) {}
      } else if (this._pausedForHidden) {
        this._pausedForHidden = false;
        this.video.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  _unbindVisibility() {
    if (this._onVisibility) {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
    this._pausedForHidden = false;
  }

  _startStats() {
    this._stopStats();
    this._lastFrames = 0;
    this._lastDropped = 0;
    this._lastStatsAt = performance.now();
    this._statsTimer = setInterval(() => this._pollStats(), 1000);
  }

  _stopStats() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  async _pollStats() {
    if (this.destroyed || typeof this.hooks.onStats !== "function") return;
    const video = this.video;
    try {
      let frames = 0;
      let droppedTotal = 0;
      if (typeof video.getVideoPlaybackQuality === "function") {
        const q = video.getVideoPlaybackQuality();
        frames = q.totalVideoFrames || 0;
        droppedTotal = q.droppedVideoFrames || 0;
      } else if (typeof video.webkitDecodedFrameCount === "number") {
        frames = video.webkitDecodedFrameCount;
        droppedTotal = video.webkitDroppedFrameCount || 0;
      }
      const now = performance.now();
      const dt = (now - this._lastStatsAt) / 1000;
      let fps = null;
      if (dt > 0 && frames >= this._lastFrames) {
        fps = (frames - this._lastFrames) / dt;
      }
      // 丢帧改为近 1 秒增量（与 FPS 同窗口），不再显示累计
      const dropped =
        droppedTotal >= this._lastDropped ? droppedTotal - this._lastDropped : 0;
      this._lastFrames = frames;
      this._lastDropped = droppedTotal;
      this._lastStatsAt = now;
      if (fps != null) this.hooks.onStats({ fps, dropped, droppedTotal });
    } catch (_) {}
  }

  _emitStatus(state) {
    if (typeof this.hooks.onStatus === "function") this.hooks.onStatus(state);
  }

  _emitError(message) {
    if (typeof this.hooks.onError === "function") this.hooks.onError(message);
  }

  destroyMediaOnly() {
    this._stopStats();
    this._unbindVisibility();
    if (this.ws) {
      try {
        if (this._onMessage) this.ws.removeEventListener("message", this._onMessage);
        this.ws.onopen = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this._onMessage = null;
    this.sb = null;
    this.ms = null;
    this._bufLen = 0;
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch (_) {}
      this.objectUrl = null;
    }
    if (this.video) {
      try {
        this.video.playbackRate = 1;
        this.video.removeAttribute("src");
        this.video.srcObject = null;
        this.video.load();
      } catch (_) {}
    }
  }

  destroy() {
    this.destroyed = true;
    this.destroyMediaOnly();
  }
}
