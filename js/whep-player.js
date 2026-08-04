/**
 * go2rtc WHEP：RTCPeerConnection + POST application/sdp
 */
export class WhepPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onStatus?: Function, onError?: Function, onStats?: Function }} hooks
   */
  constructor(video, hooks = {}) {
    this.video = video;
    this.hooks = hooks;
    this.pc = null;
    this.destroyed = false;
    this._statsTimer = null;
    this._lastFrames = 0;
    this._lastStatsAt = 0;
  }

  /**
   * @param {string} whepUrl e.g. http://127.0.0.1:1984/api/webrtc?src=cam_xxx
   */
  async play(whepUrl) {
    this.destroyPcOnly();
    this.destroyed = false;
    this._emitStatus("connecting");

    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("当前环境不支持 WebRTC");
    }

    const pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    this.pc = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      if (this.destroyed) return;
      const stream = ev.streams?.[0] || new MediaStream([ev.track]);
      this.video.srcObject = stream;
      this.video.play().catch(() => {});
      this._emitStatus("online");
      this._startStats();
    };

    pc.onconnectionstatechange = () => {
      if (this.destroyed) return;
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this._emitStatus("offline");
        if (s === "failed") this._emitError("WebRTC 连接失败");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc, 2500);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new Error("无法生成 SDP Offer");

    const res = await fetch(whepUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
      },
      body: localSdp,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WHEP 失败 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const answerSdp = await res.text();
    if (!answerSdp || !answerSdp.includes("v=0")) {
      throw new Error("WHEP 返回无效 SDP Answer");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    if (!this.destroyed) {
      // ontrack 可能已触发；若尚未 online，仍保持 connecting 直至首帧
      this._startStats();
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
    if (this.destroyed || !this.pc || typeof this.hooks.onStats !== "function") return;
    try {
      const stats = await this.pc.getStats();
      let frames = 0;
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && (r.kind === "video" || r.mediaType === "video")) {
          if (typeof r.framesDecoded === "number") frames = r.framesDecoded;
        }
      });
      const now = performance.now();
      const dt = (now - this._lastStatsAt) / 1000;
      let fps = null;
      if (dt > 0 && frames >= this._lastFrames) {
        fps = (frames - this._lastFrames) / dt;
      }
      this._lastFrames = frames;
      this._lastStatsAt = now;
      if (fps != null) this.hooks.onStats({ fps });
    } catch (_) {}
  }

  _emitStatus(state) {
    if (typeof this.hooks.onStatus === "function") this.hooks.onStatus(state);
  }

  _emitError(message) {
    if (typeof this.hooks.onError === "function") this.hooks.onError(message);
  }

  destroyPcOnly() {
    this._stopStats();
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch (_) {}
      this.pc = null;
    }
    if (this.video) {
      try {
        this.video.srcObject = null;
      } catch (_) {}
    }
  }

  destroy() {
    this.destroyed = true;
    this.destroyPcOnly();
  }
}

function waitIceGatheringComplete(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
