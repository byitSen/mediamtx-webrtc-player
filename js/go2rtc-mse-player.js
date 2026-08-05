/**
 * go2rtc WebSocket MSE → <video>
 * 低延迟优化：分片队列优先 append、短缓冲、按 gap 调 playbackRate 追直播边缘
 */
const MSE_CODECS = [
  "hvc1.1.6.L153.B0",
  "hvc1.1.6.L123.B0",
  "hvc1.1.6.L93.B0",
  "hev1.1.6.L93.B0",
  "avc1.640033",
  "avc1.64002A",
  "avc1.640029",
  "avc1.640028",
  "avc1.4D401F",
  "avc1.42E01E",
  "mp4a.40.2",
  "mp4a.40.5",
  "opus",
];

/** 保留的直播缓冲时长（秒）——过长会感觉掉帧/延迟 */
const LIVE_BUFFER_SEC = 2.5;
/** 队列总字节上限，超限丢弃最旧分片（背压） */
const MAX_QUEUE_BYTES = 1.5 * 1024 * 1024;
/** 队列分片数上限 */
const MAX_QUEUE_CHUNKS = 48;

function getMediaSourceCtor() {
  if (typeof ManagedMediaSource !== "undefined") return ManagedMediaSource;
  if (typeof MediaSource !== "undefined") return MediaSource;
  return null;
}

function supportedCodecList(isTypeSupported, preferredVideoCodec = "h265") {
  const preferH264 = String(preferredVideoCodec).toLowerCase() === "h264";
  const video = MSE_CODECS.filter((c) =>
    preferH264 ? c.startsWith("avc1") : c.startsWith("hvc1") || c.startsWith("hev1")
  );
  const audio = MSE_CODECS.filter((c) => c.startsWith("mp4a") || c === "opus" || c === "flac");
  return [...video, ...audio]
    .filter((c) => {
      try {
        return isTypeSupported(`video/mp4; codecs="${c}"`);
      } catch (_) {
        return false;
      }
    })
    .join(",");
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
    /** @type {Uint8Array[]} */
    this._queue = [];
    this._queueBytes = 0;
    this._statsTimer = null;
    this._chaseTimer = null;
    this._lastFrames = 0;
    this._lastStatsAt = 0;
    this._onMessage = null;
  }

  /**
   * @param {string} wsUrl e.g. ws://127.0.0.1:1984/api/ws?src=cam_xxx
   * @param {{ preferredVideoCodec?: "h265"|"h264" }} [opts]
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
    const codecs = supportedCodecList(MS.isTypeSupported.bind(MS), prefer);
    if (!codecs) {
      throw new Error(
        prefer === "h265"
          ? "当前环境不支持 H.265 MSE（可在设置中改选 H.264，或安装 HEVC 扩展）"
          : "当前环境不支持 H.264 MSE"
      );
    }
    console.info(`[mse] 协商编码优先: ${prefer} → ${codecs}`);

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
              this.sb = this.ms.addSourceBuffer(msg.value);
              // sequence：直播时间戳间隙更稳，减少卡顿
              this.sb.mode = "sequence";
              this.sb.addEventListener("updateend", () => this._onUpdateEnd());
              this._emitStatus("online");
              this._startStats();
              this._startChaseLoop();
              this._pump();
              ok();
            } catch (e) {
              fail(e);
            }
          }
          return;
        }
        this._enqueue(toU8(ev.data));
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

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _enqueue(chunk) {
    if (!chunk?.byteLength || this.destroyed) return;
    this._queue.push(chunk);
    this._queueBytes += chunk.byteLength;

    // 背压：丢最旧分片，保住直播边缘
    while (
      this._queue.length > 1 &&
      (this._queueBytes > MAX_QUEUE_BYTES || this._queue.length > MAX_QUEUE_CHUNKS)
    ) {
      const dropped = this._queue.shift();
      this._queueBytes -= dropped.byteLength;
    }
    this._pump();
  }

  /** 优先 append，trim/chase 让路 */
  _pump() {
    if (!this.sb || this.destroyed || this.sb.updating) return;

    if (this._queue.length) {
      const chunk = this._queue.shift();
      this._queueBytes = Math.max(0, this._queueBytes - chunk.byteLength);
      try {
        this.sb.appendBuffer(chunk);
      } catch (e) {
        const name = e?.name || "";
        if (name === "QuotaExceededError") {
          // 缓冲满：丢掉队列前半 + 强力裁剪后再试
          while (this._queue.length > 4) {
            const d = this._queue.shift();
            this._queueBytes -= d.byteLength;
          }
          this._queue.unshift(chunk);
          this._queueBytes += chunk.byteLength;
          this._forceTrim(1.2);
          return;
        }
        console.warn("[mse] appendBuffer", name, e?.message || e);
        // 跳过坏片，继续
        this._pump();
      }
      return;
    }

    this._trimAndChase();
  }

  _onUpdateEnd() {
    if (!this.sb || this.destroyed) return;
    this._pump();
  }

  _forceTrim(keepSec) {
    const sb = this.sb;
    if (!sb || sb.updating || !sb.buffered?.length) return;
    try {
      const end = sb.buffered.end(sb.buffered.length - 1);
      const start0 = sb.buffered.start(0);
      const keepFrom = Math.max(start0, end - keepSec);
      if (keepFrom > start0 + 0.05) {
        sb.remove(start0, keepFrom);
      }
    } catch (_) {}
  }

  /**
   * 对齐 go2rtc VideoRTC：短缓冲 + 按 gap 调速追边缘
   * gap 大 → 加速；几乎贴边 → 略降速等数据，避免抽帧感
   */
  _trimAndChase() {
    const sb = this.sb;
    const video = this.video;
    if (!sb || sb.updating || !sb.buffered?.length || this.destroyed) return;

    // 队列非空时让路给 append
    if (this._queue.length) {
      this._pump();
      return;
    }

    try {
      const end = sb.buffered.end(sb.buffered.length - 1);
      const start0 = sb.buffered.start(0);
      const keepFrom = Math.max(start0, end - LIVE_BUFFER_SEC);

      if (keepFrom > start0 + 0.35) {
        sb.remove(start0, keepFrom);
        try {
          this.ms?.setLiveSeekableRange?.(keepFrom, end);
        } catch (_) {}
        return;
      }

      if (video.paused) {
        video.play().catch(() => {});
      }

      // 掉到缓冲起点之前：拉回
      if (video.currentTime < keepFrom) {
        video.currentTime = keepFrom;
      }

      const gap = end - video.currentTime;
      // 落后过多：硬追到边缘附近
      if (gap > 1.0) {
        video.currentTime = Math.max(keepFrom, end - 0.25);
        video.playbackRate = 1;
        return;
      }
      // VideoRTC：playbackRate ≈ gap，落后则加速追平
      if (gap > 0.12) {
        video.playbackRate = Math.min(2.0, Math.max(1.05, gap));
      } else if (gap < 0.04) {
        video.playbackRate = 0.9;
      } else {
        video.playbackRate = 1;
      }
    } catch (_) {}
  }

  _startChaseLoop() {
    this._stopChaseLoop();
    // 即使 SourceBuffer 空闲也周期性追帧，避免只在 updateend 才调整
    this._chaseTimer = setInterval(() => {
      if (this.destroyed) return;
      if (!this.sb?.updating) this._trimAndChase();
    }, 250);
  }

  _stopChaseLoop() {
    if (this._chaseTimer) {
      clearInterval(this._chaseTimer);
      this._chaseTimer = null;
    }
  }

  _startStats() {
    this._stopStats();
    this._lastFrames = 0;
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
      let dropped = 0;
      if (typeof video.getVideoPlaybackQuality === "function") {
        const q = video.getVideoPlaybackQuality();
        frames = q.totalVideoFrames || 0;
        dropped = q.droppedVideoFrames || 0;
      } else if (typeof video.webkitDecodedFrameCount === "number") {
        frames = video.webkitDecodedFrameCount;
        dropped = video.webkitDroppedFrameCount || 0;
      }
      const now = performance.now();
      const dt = (now - this._lastStatsAt) / 1000;
      let fps = null;
      if (dt > 0 && frames >= this._lastFrames) {
        fps = (frames - this._lastFrames) / dt;
      }
      this._lastFrames = frames;
      this._lastStatsAt = now;
      if (fps != null) this.hooks.onStats({ fps, dropped });
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
    this._stopChaseLoop();
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
    this._queue = [];
    this._queueBytes = 0;
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
