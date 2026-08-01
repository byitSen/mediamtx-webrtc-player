/**
 * H.265 AnnexB → WebCodecs VideoDecoder → canvas
 * - 按 Access Unit 攒多 slice 再 decode
 * - 解码送入串行
 * - 解码后立即渲染（低延迟，避免 fMP4 关键帧间隔卡帧）
 */
const START_CODE_4 = [0, 0, 0, 1];

function findStartCode(data, from = 0) {
  for (let i = from; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) return { index: i, length: 3 };
      if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        return { index: i, length: 4 };
      }
    }
  }
  return null;
}

function nalType(nal) {
  if (!nal || nal.length < 1) return -1;
  return (nal[0] >> 1) & 0x3f;
}

function isVclNal(type) {
  return type >= 0 && type <= 31;
}

function isKeyNal(type) {
  return type === 19 || type === 20 || type === 21;
}

function isFirstSliceOfPic(nal) {
  if (!nal || nal.length < 3) return true;
  return (nal[2] & 0x80) !== 0;
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + (p?.length || 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    if (!p || !p.length) continue;
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function withStartCode(nal) {
  return concatBytes(new Uint8Array(START_CODE_4), nal);
}

export class H265Player {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onStatus?: Function, onError?: Function, onFrame?: Function, onStats?: Function }} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hooks = hooks;

    this.ws = null;
    this.decoder = null;
    this.buffer = new Uint8Array(0);
    this.vps = null;
    this.sps = null;
    this.pps = null;
    this.configured = false;
    this._configPromise = null;
    this.destroyed = false;
    this.timestampUs = 0;
    this.frameDurationUs = 40000;

    this.pendingAccessUnit = [];
    this.pendingHasVcl = false;
    this.pendingIsKey = false;

    /** @type {{ nals: Uint8Array[], isKey: boolean }[]} */
    this._decodeQueue = [];
    this._decodeBusy = false;

    this._frameCount = 0;
    this.lastStatsAt = 0;
  }

  async play(wsUrl) {
    this.destroySocketOnly();
    this.destroyed = false;
    this._ensureDecoder();
    this._emitStatus("connecting");

    await new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        this._emitStatus("online");
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
        const chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data);
        this._onBinary(chunk);
      };
    });
  }

  _ensureDecoder() {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("当前环境不支持 WebCodecs VideoDecoder");
    }
    if (this.decoder && this.decoder.state !== "closed") return;

    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecodedFrame(frame),
      error: (err) => {
        console.error("[H265Player] decoder error:", err);
        this._emitError(err?.message || "解码失败（请确认系统支持 HEVC 硬解）");
      },
    });
    this.configured = false;
    this._configPromise = null;
  }

  _onDecodedFrame(frame) {
    if (this.destroyed) {
      try {
        frame.close();
      } catch (_) {}
      return;
    }
    this._drawFrame(frame);
  }

  _onBinary(chunk) {
    this.buffer = concatBytes(this.buffer, chunk);
    this._parseAnnexB();
  }

  _parseAnnexB() {
    while (true) {
      const first = findStartCode(this.buffer, 0);
      if (!first) {
        if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-64);
        return;
      }
      if (first.index > 0) this.buffer = this.buffer.slice(first.index);

      const next = findStartCode(this.buffer, first.length);
      if (!next) {
        if (this.buffer.length > 4 * 1024 * 1024) {
          this.buffer = this.buffer.slice(-1024 * 1024);
        }
        return;
      }

      const nal = this.buffer.slice(first.length, next.index);
      this.buffer = this.buffer.slice(next.index);
      if (nal.length) this._handleNal(nal);
    }
  }

  _flushPendingAu() {
    if (!this.pendingAccessUnit.length || !this.pendingHasVcl) {
      this.pendingAccessUnit = [];
      this.pendingHasVcl = false;
      this.pendingIsKey = false;
      return;
    }
    const nals = this.pendingAccessUnit;
    const isKey = this.pendingIsKey;
    this.pendingAccessUnit = [];
    this.pendingHasVcl = false;
    this.pendingIsKey = false;
    this._enqueueDecode(nals, isKey);
  }

  _handleNal(nal) {
    const type = nalType(nal);

    if (type === 32) {
      this.vps = nal;
      return;
    }
    if (type === 33) {
      this.sps = nal;
      return;
    }
    if (type === 34) {
      this.pps = nal;
      return;
    }

    if (type === 35) {
      this._flushPendingAu();
      return;
    }

    if (type === 39 || type === 40) {
      if (!this.pendingHasVcl) this.pendingAccessUnit.push(nal);
      return;
    }

    if (!isVclNal(type)) return;

    if (isFirstSliceOfPic(nal) && this.pendingHasVcl) {
      this._flushPendingAu();
    }

    this.pendingAccessUnit.push(nal);
    this.pendingHasVcl = true;
    if (isKeyNal(type)) this.pendingIsKey = true;
  }

  _enqueueDecode(nals, isKey) {
    this._decodeQueue.push({ nals, isKey });
    void this._pumpDecode();
  }

  async _pumpDecode() {
    if (this._decodeBusy) return;
    this._decodeBusy = true;
    try {
      while (this._decodeQueue.length && !this.destroyed) {
        const item = this._decodeQueue.shift();
        await this._decodeAccessUnit(item.nals, item.isKey);
      }
    } finally {
      this._decodeBusy = false;
      if (this._decodeQueue.length && !this.destroyed) {
        void this._pumpDecode();
      }
    }
  }

  async _configureIfNeeded(isKey) {
    if (this.configured || !this.decoder) return true;
    if (!this.vps || !this.sps || !this.pps) {
      if (isKey) this._emitError("等待 VPS/SPS/PPS…");
      return false;
    }
    if (this._configPromise) return this._configPromise;

    this._configPromise = (async () => {
      const codecCandidates = ["hev1.1.6.L93.B0", "hvc1.1.6.L93.B0", "hev1.1.6.L120.B0"];
      let lastErr = null;
      for (const codec of codecCandidates) {
        try {
          const config = { codec, optimizeForLatency: true };
          const support = await VideoDecoder.isConfigSupported(config);
          if (!support?.supported) continue;
          this.decoder.configure(config);
          this.configured = true;
          return true;
        } catch (e) {
          lastErr = e;
        }
      }
      this._emitError(lastErr?.message || "HEVC 解码器配置失败（系统可能未安装 HEVC 扩展）");
      return false;
    })();

    try {
      return await this._configPromise;
    } finally {
      if (!this.configured) this._configPromise = null;
    }
  }

  async _decodeAccessUnit(nals, isKey) {
    if (!nals?.length || !this.decoder) return;

    const ok = await this._configureIfNeeded(isKey);
    if (!ok || !this.configured) return;
    if (this.decoder.state === "closed") return;

    const parts = [];
    if (isKey && this.vps && this.sps && this.pps) {
      parts.push(withStartCode(this.vps), withStartCode(this.sps), withStartCode(this.pps));
    }
    for (const nal of nals) parts.push(withStartCode(nal));
    const data = concatBytes(...parts);

    try {
      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: this.timestampUs,
        duration: this.frameDurationUs,
        data,
      });
      this.timestampUs += this.frameDurationUs;
      this.decoder.decode(chunk);
    } catch (e) {
      console.warn("[H265Player] decode:", e?.message || e);
    }
  }

  _drawFrame(frame) {
    try {
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
        if (typeof this.hooks.onFrame === "function") {
          this.hooks.onFrame({ width: frame.displayWidth, height: frame.displayHeight });
        }
      }
      this.ctx.drawImage(frame, 0, 0);
      this._frameCount += 1;
      const now = performance.now();
      if (!this.lastStatsAt) this.lastStatsAt = now;
      if (now - this.lastStatsAt >= 1000) {
        const fps = this._frameCount / ((now - this.lastStatsAt) / 1000);
        this._frameCount = 0;
        this.lastStatsAt = now;
        if (typeof this.hooks.onStats === "function") {
          this.hooks.onStats({ fps });
        }
      }
    } finally {
      frame.close();
    }
  }

  _emitStatus(state) {
    if (typeof this.hooks.onStatus === "function") this.hooks.onStatus(state);
  }

  _emitError(message) {
    if (typeof this.hooks.onError === "function") this.hooks.onError(message);
  }

  destroySocketOnly() {
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
  }

  destroy() {
    this.destroyed = true;
    this.destroySocketOnly();
    this.buffer = new Uint8Array(0);
    this.pendingAccessUnit = [];
    this.pendingHasVcl = false;
    this.pendingIsKey = false;
    this._decodeQueue = [];
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch (_) {}
      this.decoder = null;
    }
    this.configured = false;
    this._configPromise = null;
  }
}
