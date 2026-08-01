/**
 * WebSocket fMP4 → MSE → <video>
 * 关键修复：按 MP4 box 边界重组后再 append；裁剪缓冲并追直播边缘，避免播几秒卡住。
 */

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + (p?.byteLength || 0), 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    if (!p || !p.byteLength) continue;
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** 尝试从缓冲头部解析一个完整 ISO BMFF box，不够则返回 null */
function tryReadBox(buf) {
  if (!buf || buf.length < 8) return null;
  let size = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
  const type = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  let header = 8;
  if (size === 1) {
    if (buf.length < 16) return null;
    // 64-bit size（高 32 位忽略，直播片段通常远小于 4GB）
    size =
      ((buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11]) * 0x100000000 +
      ((buf[12] << 24) | (buf[13] << 16) | (buf[14] << 8) | buf[15]);
    header = 16;
  } else if (size === 0) {
    // 至文件结束：直播管道中不当作完整 box
    return null;
  }
  if (size < header || size > 64 * 1024 * 1024) return null;
  if (buf.length < size) return null;
  return {
    type,
    size,
    data: buf.subarray(0, size),
  };
}

export function pickMseCodec() {
  const candidates = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="avc1.640028"',
    'video/mp4; codecs="avc1.4D401E"',
    'video/mp4; codecs="avc1.42E01E"',
  ];
  if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported) {
    return null;
  }
  for (const c of candidates) {
    if (MediaSource.isTypeSupported(c)) return c;
  }
  return null;
}

export class RtspMsePlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onStatus?: Function, onError?: Function, onStats?: Function }} hooks
   */
  constructor(video, hooks = {}) {
    this.video = video;
    this.hooks = hooks;
    this.ws = null;
    this.mse = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.isUpdating = false;
    this.destroyed = false;
    this.objectUrl = null;
    this.frameCount = 0;
    this.lastStatsAt = 0;
    this._statsTimer = null;
    this._watchTimer = null;
    this._pending = new Uint8Array(0);
    this._initParts = [];
    this._segParts = null;
    this._initDone = false;
    this._mime = null;
    this._lastDecodedFrames = null;
    this._presentedFrames = 0;
    this._rvfcHandle = null;
    this._lastFps = 0;
    this._zeroStreak = 0;
    this._lastCurrentTime = null;
  }

  async play(wsUrl, codec) {
    this.destroyMediaOnly();
    this.destroyed = false;
    const mime = codec || pickMseCodec();
    if (!mime) {
      throw new Error("当前环境不支持 MSE 视频解码（H.265 可能需安装 HEVC 扩展）");
    }
    this._mime = mime;

    this._emitStatus("connecting");
    this.mse = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mse);
    this.video.src = this.objectUrl;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        try {
          this.sourceBuffer = this.mse.addSourceBuffer(mime);
          // sequence 对直播 fMP4 更稳，忽略异常时间戳间隙
          this.sourceBuffer.mode = "sequence";
          this.sourceBuffer.addEventListener("updateend", () => {
            this.isUpdating = false;
            this._trimAndChase();
            this._processQueue();
          });
          this.sourceBuffer.addEventListener("error", () => {
            this._emitError("SourceBuffer 错误");
          });
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      this.mse.addEventListener("sourceopen", onOpen, { once: true });
      this.mse.addEventListener("error", () => reject(new Error("MediaSource 错误")), { once: true });
    });

    await this._connectWs(wsUrl);
    this._emitStatus("online");
    this.video.play().catch(() => {});
    this._startStats();
    this._startWatchdog();
  }

  _connectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket 连接失败"));
        } else {
          this._emitError("WebSocket 错误");
        }
      };
      ws.onclose = () => {
        if (!this.destroyed) this._emitStatus("offline");
      };
      ws.onmessage = (ev) => {
        if (this.destroyed) return;
        const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data);
        this._ingest(data);
      };
    });
  }

  _ingest(chunk) {
    this._pending = concatBytes(this._pending, chunk);
    // 防止异常流撑爆内存
    if (this._pending.length > 16 * 1024 * 1024) {
      console.warn("[RtspMsePlayer] pending 过大，重置解析缓冲");
      this._pending = new Uint8Array(0);
      this._segParts = null;
      return;
    }

    while (true) {
      const box = tryReadBox(this._pending);
      if (!box) break;
      this._pending = this._pending.subarray(box.size);
      this._onBox(box);
    }
  }

  _onBox(box) {
    const t = box.type;
    if (t === "ftyp" || t === "styp") {
      if (this._initDone) {
        // 不应在同一会话复用：忽略后续 init，等待 WS 关闭重连
        console.warn("[RtspMsePlayer] 收到新的 ftyp，忽略（等待重连）");
        return;
      }
      this._initParts.push(box.data);
      return;
    }
    if (t === "moov") {
      if (!this._initDone) {
        this._initParts.push(box.data);
        this.queue.push(concatBytes(...this._initParts));
        this._initParts = [];
        this._initDone = true;
        this._processQueue();
      }
      return;
    }
    if (t === "moof") {
      this._segParts = [box.data];
      return;
    }
    if (t === "mdat") {
      if (this._segParts && this._segParts.length) {
        this._segParts.push(box.data);
        this.queue.push(concatBytes(...this._segParts));
        this._segParts = null;
        this._processQueue();
      }
      return;
    }
    // sidx / free / other：挂到当前片段或忽略
    if (this._segParts) {
      this._segParts.push(box.data);
    } else if (!this._initDone) {
      this._initParts.push(box.data);
    }
  }

  _processQueue() {
    if (this.isUpdating || !this.sourceBuffer || this.queue.length === 0) return;
    if (this.sourceBuffer.updating) return;
    if (this.mse && this.mse.readyState !== "open") return;

    const chunk = this.queue.shift();
    this.isUpdating = true;
    try {
      this.sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      this.isUpdating = false;
      const name = e?.name || "";
      console.warn("[RtspMsePlayer] appendBuffer:", name, e?.message || e);
      if (name === "QuotaExceededError") {
        this._forceTrim();
        // 稍后重试该块
        this.queue.unshift(chunk);
        setTimeout(() => this._processQueue(), 50);
        return;
      }
      if (this.queue.length > 80) this.queue.splice(0, this.queue.length - 30);
      setTimeout(() => this._processQueue(), 20);
    }
  }

  _forceTrim() {
    const sb = this.sourceBuffer;
    const v = this.video;
    if (!sb || sb.updating || !sb.buffered.length) return;
    try {
      const start = sb.buffered.start(0);
      const end = sb.buffered.end(sb.buffered.length - 1);
      const keepFrom = Math.max(start, (v.currentTime || end) - 1.5);
      if (keepFrom > start + 0.2) {
        sb.remove(start, keepFrom);
        this.isUpdating = true;
      }
    } catch (e) {
      console.warn("[RtspMsePlayer] forceTrim:", e?.message || e);
    }
  }

  _trimAndChase() {
    const sb = this.sourceBuffer;
    const v = this.video;
    if (!sb || sb.updating || !sb.buffered.length) return;

    try {
      const start = sb.buffered.start(0);
      const end = sb.buffered.end(sb.buffered.length - 1);
      const ct = v.currentTime || 0;

      // 只保留约 3s 历史，避免缓冲区撑满后卡住
      if (ct - start > 3.5) {
        const removeEnd = Math.max(start + 0.1, ct - 2);
        if (removeEnd > start) {
          sb.remove(start, removeEnd);
          this.isUpdating = true;
          return; // updateend 会继续
        }
      }

      // 追直播边缘：落后太多则跳近；贴边卡住时轻推
      const lag = end - ct;
      if (lag > 1.2) {
        v.currentTime = Math.max(0, end - 0.25);
      } else if (lag < 0.05 && lag >= 0 && !v.paused) {
        // 已播到缓冲末尾：等下一片；若 waiting 过久由 watchdog 继续 play
      }

      if (v.paused || v.ended || v.readyState < 2) {
        v.play().catch(() => {});
      }
    } catch (e) {
      console.warn("[RtspMsePlayer] trimAndChase:", e?.message || e);
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._watchTimer = setInterval(() => {
      if (this.destroyed || !this.video) return;
      // 有数据却暂停/卡在缓冲末尾时强制推进
      this._trimAndChase();
      if (!this.isUpdating && this.queue.length) this._processQueue();
      // rvfc 在 seek/重建后可能中断，播放中则补挂
      if (this._statsTimer && this._rvfcHandle == null && !this.video.paused) {
        this._startRvfc();
      }
    }, 500);
  }

  _stopWatchdog() {
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  /** 读取解码帧计数；不可靠时返回 null */
  _readDecodedFrames() {
    const v = this.video;
    if (!v) return null;
    try {
      if (typeof v.webkitDecodedFrameCount === "number" && v.webkitDecodedFrameCount > 0) {
        return v.webkitDecodedFrameCount;
      }
      if (typeof v.getVideoPlaybackQuality === "function") {
        const q = v.getVideoPlaybackQuality();
        if (q && typeof q.totalVideoFrames === "number" && q.totalVideoFrames > 0) {
          return q.totalVideoFrames;
        }
      }
    } catch (_) {}
    return null;
  }

  _onPresentedFrame() {
    if (this.destroyed) return;
    this._presentedFrames += 1;
    if (typeof this.video?.requestVideoFrameCallback === "function") {
      this._rvfcHandle = this.video.requestVideoFrameCallback(() => this._onPresentedFrame());
    }
  }

  _startRvfc() {
    this._stopRvfc();
    this._presentedFrames = 0;
    if (typeof this.video?.requestVideoFrameCallback === "function") {
      this._rvfcHandle = this.video.requestVideoFrameCallback(() => this._onPresentedFrame());
    }
  }

  _stopRvfc() {
    if (this._rvfcHandle != null && typeof this.video?.cancelVideoFrameCallback === "function") {
      try {
        this.video.cancelVideoFrameCallback(this._rvfcHandle);
      } catch (_) {}
    }
    this._rvfcHandle = null;
  }

  _startStats() {
    this._stopStats();
    this.lastStatsAt = performance.now();
    this._lastDecodedFrames = this._readDecodedFrames();
    this._presentedFrames = 0;
    this._lastFps = 0;
    this._zeroStreak = 0;
    this._startRvfc();
    this._statsTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.max(0.001, (now - this.lastStatsAt) / 1000);
      let fps = 0;

      // 优先：实际呈现帧（requestVideoFrameCallback）
      if (this._rvfcHandle != null || this._presentedFrames > 0) {
        fps = this._presentedFrames / dt;
        this._presentedFrames = 0;
      }

      // 次选：解码帧计数增量
      if (fps < 0.5) {
        const decoded = this._readDecodedFrames();
        if (decoded != null && this._lastDecodedFrames != null) {
          fps = Math.max(fps, (decoded - this._lastDecodedFrames) / dt);
        }
        this._lastDecodedFrames = decoded ?? this._lastDecodedFrames;
      } else {
        const decoded = this._readDecodedFrames();
        if (decoded != null) this._lastDecodedFrames = decoded;
      }

      // 再选：播放头推进估算（约等于帧率不够时的下限）
      if (fps < 0.5 && this.video && !this.video.paused) {
        const ct = this.video.currentTime || 0;
        if (this._lastCurrentTime != null) {
          const dMedia = ct - this._lastCurrentTime;
          // 时间轴前进且未大幅 seek 时，按「每秒一单位时间 ≈ 无法直接得 fps」；
          // 改用 readyState + 未暂停时保留上次有效值
          if (dMedia > 0.05 && dMedia < 2) {
            // 无帧 API 时无法从 currentTime 精确推 fps，仅作「在播」信号
            if (this._lastFps > 0) fps = this._lastFps;
          }
        }
        this._lastCurrentTime = ct;
      } else if (this.video) {
        this._lastCurrentTime = this.video.currentTime || 0;
      }

      // 短暂抖动为 0 时保留上次有效值，避免小窗口闪 0
      if (fps < 0.5) {
        this._zeroStreak += 1;
        if (this._zeroStreak <= 2 && this._lastFps > 0 && this.video && !this.video.paused) {
          fps = this._lastFps;
        }
      } else {
        this._zeroStreak = 0;
        this._lastFps = fps;
      }

      this.lastStatsAt = now;
      if (typeof this.hooks.onStats === "function") this.hooks.onStats({ fps });
    }, 1000);
  }

  _stopStats() {
    this._stopRvfc();
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  _emitStatus(s) {
    if (typeof this.hooks.onStatus === "function") this.hooks.onStatus(s);
  }

  _emitError(m) {
    if (typeof this.hooks.onError === "function") this.hooks.onError(m);
  }

  destroyMediaOnly() {
    this._stopStats();
    this._stopWatchdog();
    this._lastFps = 0;
    this._zeroStreak = 0;
    this._lastCurrentTime = null;
    this._lastDecodedFrames = null;
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.queue = [];
    this._pending = new Uint8Array(0);
    this._initParts = [];
    this._segParts = null;
    this._initDone = false;
    this.isUpdating = false;
    this.sourceBuffer = null;
    if (this.mse && this.mse.readyState === "open") {
      try {
        this.mse.endOfStream();
      } catch (_) {}
    }
    this.mse = null;
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch (_) {}
      this.objectUrl = null;
    }
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    } catch (_) {}
  }

  destroy() {
    this.destroyed = true;
    this.destroyMediaOnly();
  }
}
