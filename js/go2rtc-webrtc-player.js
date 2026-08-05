/**
 * go2rtc WebSocket 信令 + WebRTC → <video>
 *
 * 对齐官方 VideoRTC.onwebrtc()（mode=webrtc）：
 * https://github.com/AlexxIT/go2rtc/blob/master/www/video-rtc.js
 *
 * 协议：https://github.com/AlexxIT/go2rtc/blob/master/internal/api/ws/README.md
 * - {type:'webrtc/offer', value: sdp}
 * - {type:'webrtc/answer', value: sdp}
 * - {type:'webrtc/candidate', value: candidate}
 */
const PC_CONFIG = {
  bundlePolicy: "max-bundle",
  iceServers: [
    {
      urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
    },
  ],
  sdpSemantics: "unified-plan",
};

export class Go2rtcWebrtcPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ onStatus?: Function, onError?: Function, onStats?: Function }} hooks
   */
  constructor(video, hooks = {}) {
    this.video = video;
    this.hooks = hooks;
    this.ws = null;
    this.pc = null;
    this.destroyed = false;
    this._statsTimer = null;
    this._lastFrames = 0;
    this._lastDropped = 0;
    this._lastStatsAt = 0;
    this._onMessage = null;
    this._preferTcp = false;
  }

  /**
   * @param {string} wsUrl e.g. ws://127.0.0.1:1984/api/ws?src=cam_xxx
   * @param {{ preferredVideoCodec?: "h265"|"h264", media?: string, webrtcTcp?: boolean }} [opts]
   */
  async play(wsUrl, opts = {}) {
    this.destroyMediaOnly();
    this.destroyed = false;
    this._preferTcp = !!opts.webrtcTcp;
    this._emitStatus("connecting");

    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("当前环境不支持 WebRTC (RTCPeerConnection)");
    }

    const media = opts.media || "video"; // 监控默认仅视频
    const prefer = opts.preferredVideoCodec === "h264" ? "h264" : "h265";

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

      ws.addEventListener("error", () => fail(new Error("WebRTC 信令 WebSocket 连接失败")));
      ws.addEventListener("close", () => {
        // 官方在 WebRTC 连上后会主动关 WS；仅在尚未成功时视为失败
        if (this.destroyed || settled) return;
        if (this.pc && (this.pc.connectionState === "connected" || this.pc.iceConnectionState === "connected")) {
          return;
        }
        this._emitStatus("offline");
        this._emitError("信令连接已关闭");
      });

      this._onMessage = async (ev) => {
        if (this.destroyed || typeof ev.data !== "string") return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        await this._onSignal(msg, fail);
      };
      ws.addEventListener("message", this._onMessage);

      ws.addEventListener("open", async () => {
        try {
          await this._startPeer(media, prefer, fail, ok);
        } catch (e) {
          fail(e);
        }
      });
    });
  }

  /**
   * 官方 onwebrtc + createOffer（仅 recvonly，无麦克风）
   */
  async _startPeer(media, preferCodec, fail, ok) {
    const pc = new RTCPeerConnection(PC_CONFIG);
    this.pc = pc;
    let announced = false;

    const announceOnline = () => {
      if (this.destroyed || announced || this.pc !== pc) return;
      const ice = pc.iceConnectionState;
      const conn = pc.connectionState;
      const up =
        conn === "connected" || ice === "connected" || ice === "completed";
      if (!up) return;
      announced = true;
      this._attachRemoteTracks(pc);
      this._emitStatus("online");
      this._startStats();
      // 官方：WebRTC 成功后关闭 WebSocket 信令
      this._closeWsOnly();
      ok();
    };

    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate && this._preferTcp && ev.candidate.protocol === "udp") return;
      const candidate = ev.candidate ? ev.candidate.toJSON().candidate : "";
      this._send({ type: "webrtc/candidate", value: candidate });
    });

    pc.addEventListener("track", (ev) => {
      if (this.destroyed || this.pc !== pc) return;
      // 有些 WebView 先到 track 再变 connected；先挂上画面
      if (ev.streams?.[0]) {
        this.video.srcObject = ev.streams[0];
      } else if (ev.track) {
        const stream = this.video.srcObject instanceof MediaStream
          ? this.video.srcObject
          : new MediaStream();
        stream.addTrack(ev.track);
        this.video.srcObject = stream;
      }
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.play().catch(() => {});
      announceOnline();
    });

    pc.addEventListener("connectionstatechange", () => {
      if (this.destroyed || this.pc !== pc) return;
      const state = pc.connectionState;
      if (state === "connected") {
        announceOnline();
      } else if (state === "failed" || state === "disconnected") {
        if (announced) {
          this._emitStatus("offline");
          this._emitError(state === "failed" ? "WebRTC 连接失败" : "WebRTC 已断开");
        }
        try {
          pc.close();
        } catch (_) {}
        if (this.pc === pc) this.pc = null;
        if (!announced) fail(new Error(state === "failed" ? "WebRTC 连接失败" : "WebRTC 已断开"));
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      if (this.destroyed || this.pc !== pc) return;
      announceOnline();
      if (pc.iceConnectionState === "failed" && !announced) {
        fail(new Error("ICE 连接失败"));
      }
    });

    // recvonly transceiver（对齐 createOffer 循环）
    for (const kind of ["video", "audio"]) {
      if (!media.includes(kind)) continue;
      const tr = pc.addTransceiver(kind, { direction: "recvonly" });
      if (kind === "video") {
        this._preferVideoCodec(tr, preferCodec);
      }
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._send({ type: "webrtc/offer", value: offer.sdp });
  }

  /** 尽量按设置偏好 H.265 / H.264（浏览器支持时） */
  _preferVideoCodec(transceiver, prefer) {
    try {
      const caps = RTCRtpReceiver.getCapabilities?.("video");
      if (!caps?.codecs?.length || !transceiver.setCodecPreferences) return;
      const want = prefer === "h264" ? ["video/h264"] : ["video/h265", "video/hevc"];
      const preferred = [];
      const rest = [];
      for (const c of caps.codecs) {
        const mime = String(c.mimeType || "").toLowerCase();
        if (want.some((w) => mime === w)) preferred.push(c);
        else rest.push(c);
      }
      if (preferred.length) {
        transceiver.setCodecPreferences([...preferred, ...rest]);
        console.info(`[webrtc] codec preference: ${prefer}`, preferred.map((c) => c.mimeType));
      }
    } catch (e) {
      console.warn("[webrtc] setCodecPreferences", e);
    }
  }

  async _onSignal(msg, fail) {
    const pc = this.pc;
    if (!pc) return;

    switch (msg.type) {
      case "webrtc/candidate": {
        if (this._preferTcp && String(msg.value || "").includes(" udp ")) return;
        try {
          await pc.addIceCandidate({ candidate: msg.value || "", sdpMid: "0" });
        } catch (er) {
          console.warn("[webrtc] addIceCandidate", er);
        }
        break;
      }
      case "webrtc/answer": {
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.value });
        } catch (er) {
          fail(er);
        }
        break;
      }
      case "error": {
        // 官方：仅处理与 webrtc/offer 相关的错误
        if (!String(msg.value || "").includes("webrtc/offer")) return;
        try {
          pc.close();
        } catch (_) {}
        fail(new Error(msg.value || "webrtc/offer 失败"));
        break;
      }
      default:
        break;
    }
  }

  /** 官方：从 recvonly transceiver 取 track 绑到 video */
  _attachRemoteTracks(pc) {
    let tracks = pc
      .getTransceivers()
      .filter((tr) => tr.currentDirection === "recvonly")
      .map((tr) => tr.receiver.track)
      .filter(Boolean);

    if (!tracks.length) {
      tracks = pc
        .getReceivers()
        .map((r) => r.track)
        .filter((t) => t && t.readyState !== "ended");
    }

    if (!tracks.length) {
      console.warn("[webrtc] 无远端 track");
      return;
    }

    const stream = new MediaStream(tracks);
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.play().catch(() => {});
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _closeWsOnly() {
    if (!this.ws) return;
    try {
      if (this._onMessage) this.ws.removeEventListener("message", this._onMessage);
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
    } catch (_) {}
    this.ws = null;
    this._onMessage = null;
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
    try {
      let fps = null;
      let dropped = 0;
      let frames = 0;
      let droppedTotal = 0;

      // 优先 RTCInboundRtpStreamStats（WebRTC 更准确）
      if (this.pc) {
        const report = await this.pc.getStats();
        for (const r of report.values()) {
          if (r.type === "inbound-rtp" && (r.kind === "video" || r.mediaType === "video")) {
            if (typeof r.framesPerSecond === "number") fps = r.framesPerSecond;
            if (typeof r.framesDecoded === "number") frames = r.framesDecoded;
            if (typeof r.framesDropped === "number") droppedTotal = r.framesDropped;
          }
        }
      }

      // 回退 video 元素质量统计
      if (fps == null) {
        const video = this.video;
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
        if (dt > 0 && frames >= this._lastFrames) {
          fps = (frames - this._lastFrames) / dt;
        }
      }

      dropped = droppedTotal >= this._lastDropped ? droppedTotal - this._lastDropped : 0;
      this._lastFrames = frames;
      this._lastDropped = droppedTotal;
      this._lastStatsAt = performance.now();
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
    this._closeWsOnly();
    if (this.pc) {
      try {
        this.pc.getSenders?.().forEach((s) => {
          try {
            s.track?.stop();
          } catch (_) {}
        });
        this.pc.close();
      } catch (_) {}
      this.pc = null;
    }
    if (this.video) {
      try {
        this.video.srcObject = null;
        this.video.removeAttribute("src");
        this.video.load();
      } catch (_) {}
    }
  }

  destroy() {
    this.destroyed = true;
    this.destroyMediaOnly();
  }
}
