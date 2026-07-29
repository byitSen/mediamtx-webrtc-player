/**
 * H.265 AnnexB → WebCodecs VideoDecoder → canvas
 */
const START_CODE_3 = [0, 0, 1];
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

function isKeyNal(type) {
  // IDR_W_RADL=19, IDR_N_LP=20, CRA_NUT=21
  return type === 19 || type === 20 || type === 21;
}

function isParamNal(type) {
  return type === 32 || type === 33 || type === 34; // VPS SPS PPS
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
    this.destroyed = false;
    this.frameCount = 0;
    this.lastStatsAt = 0;
    this.pendingAccessUnit = [];
    this.pendingIsKey = false;
    this.timestampUs = 0;
  }

  async play(wsUrl) {
    this.destroySocketOnly();
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
    if (this.decoder) return;

    this.decoder = new VideoDecoder({
      output: (frame) => this._drawFrame(frame),
      error: (err) => {
        console.error("[H265Player] decoder error:", err);
        this._emitError(err?.message || "解码失败（请确认系统支持 HEVC 硬解）");
      },
    });
  }

  _onBinary(chunk) {
    this.buffer = concatBytes(this.buffer, chunk);
    this._parseAnnexB();
  }

  _parseAnnexB() {
    // Keep last incomplete NAL in buffer
    while (true) {
      const first = findStartCode(this.buffer, 0);
      if (!first) {
        if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-64);
        return;
      }
      if (first.index > 0) this.buffer = this.buffer.slice(first.index);

      const next = findStartCode(this.buffer, first.length);
      if (!next) {
        // Need more data; keep from current start code
        if (this.buffer.length > 4 * 1024 * 1024) {
          // Prevent unbounded growth on corrupt stream
          this.buffer = this.buffer.slice(-1024 * 1024);
        }
        return;
      }

      const nal = this.buffer.slice(first.length, next.index);
      this.buffer = this.buffer.slice(next.index);
      if (nal.length) this._handleNal(nal);
    }
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

    // Access unit delimiter / SEI — ignore for AU assembly simplicity
    if (type === 35 || type === 39 || type === 40) return;

    const key = isKeyNal(type);
    // Flush previous AU when a new VCL NAL starts a new picture (simplified: one VCL per AU)
    if (this.pendingAccessUnit.length) {
      this._flushAccessUnit();
    }

    this.pendingAccessUnit.push(nal);
    this.pendingIsKey = key;
    this._flushAccessUnit();
  }

  async _configureIfNeeded(isKey) {
    if (this.configured || !this.decoder) return true;
    if (!this.vps || !this.sps || !this.pps) {
      if (isKey) this._emitError("等待 VPS/SPS/PPS…");
      return false;
    }

    const codecCandidates = ["hev1.1.6.L93.B0", "hvc1.1.6.L93.B0", "hev1.1.6.L120.B0"];
    let lastErr = null;
    for (const codec of codecCandidates) {
      try {
        const config = {
          codec,
          optimizeForLatency: true,
          // hev1: in-band parameter sets
        };
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
  }

  async _flushAccessUnit() {
    const nals = this.pendingAccessUnit;
    const isKey = this.pendingIsKey;
    this.pendingAccessUnit = [];
    this.pendingIsKey = false;
    if (!nals.length || !this.decoder) return;

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
        duration: 33333,
        data,
      });
      this.timestampUs += 33333;
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
      this.frameCount += 1;
      const now = performance.now();
      if (!this.lastStatsAt) this.lastStatsAt = now;
      if (now - this.lastStatsAt >= 1000) {
        const fps = this.frameCount / ((now - this.lastStatsAt) / 1000);
        this.frameCount = 0;
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
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch (_) {}
      this.decoder = null;
    }
    this.configured = false;
  }
}
