import { buildWhepUrl, getEffectiveSettings } from "./config.js";
import { formatTimestamp, saveImageToPath } from "./utils.js";

/**
 * 在 SDP offer 的 video 段注入 H.265，使 MediaMTX 认为客户端支持 H.265 并返回 H.265 流。
 * 桌面端 Electron 下可选（Chromium 已通过 HevcVideoDecoder 启用 H.265 解码）。
 * @param {string} sdp - 原始 SDP offer
 * @returns {string} 注入 H.265 后的 SDP，若已包含 H.265 或解析失败则返回原 SDP
 */
function injectH265IntoOffer(sdp) {
  if (!sdp || typeof sdp !== "string") return sdp;
  if (/a=rtpmap:\d+\s+H265\/\d+/i.test(sdp)) return sdp;

  const lines = sdp.split(/\r?\n/);
  let videoStart = -1;
  let mVideoLineIdx = -1;
  let videoPtUsed = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("m=video ")) {
      mVideoLineIdx = i;
      if (videoStart < 0) videoStart = i;
      const parts = line.split(/\s+/);
      // m=video <port> UDP/TLS/RTP/SAVPF pt1 pt2 ...
      for (let j = 4; j < parts.length; j++) {
        const n = parseInt(parts[j], 10);
        if (!Number.isNaN(n)) videoPtUsed.add(n);
      }
    } else if (line.startsWith("a=rtpmap:") && videoStart >= 0) {
      const m = line.match(/^a=rtpmap:(\d+)/);
      if (m) videoPtUsed.add(parseInt(m[1], 10));
    } else if (line.startsWith("m=") && videoStart >= 0 && mVideoLineIdx >= 0) {
      break;
    }
  }

  if (mVideoLineIdx < 0) return sdp;
  let h265Pt = 102;
  while (videoPtUsed.has(h265Pt) && h265Pt <= 127) h265Pt++;
  if (h265Pt > 127) return sdp;

  const mLine = lines[mVideoLineIdx];
  const parts = mLine.split(/\s+/);
  if (parts.length < 5) return sdp;
  parts.splice(5, 0, String(h265Pt));
  lines[mVideoLineIdx] = parts.join(" ");

  const insertIdx = mVideoLineIdx + 1;
  const rtpmap = `a=rtpmap:${h265Pt} H265/90000`;
  const fmtp = `a=fmtp:${h265Pt} profile-id=1;level-id=93`;
  lines.splice(insertIdx, 0, rtpmap, fmtp);

  return lines.join("\r\n");
}

export class Player {
  constructor(containerEl, cameraConfig) {
    this.containerEl = containerEl;
    this.camera = cameraConfig;
    this.pc = null;
    this.stream = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.statsTimer = null;
    this.lastVideoStats = null;
    this._buildDom();
    this._bindEvents();
    // 不在构造函数中直接 connect，由懒加载/连接池控制何时连接
  }

  _buildDom() {
    this.containerEl.classList.add("player-card");

    const header = document.createElement("div");
    header.className = "player-header";

    const title = document.createElement("div");
    title.className = "player-title";
    title.textContent = this.camera.name || this.camera.path || "未命名摄像头";

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
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

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

  /** 根据视频宽高动态设置 .video-wrapper 的宽高比 */
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
    this.dom.btnFull.addEventListener("click", () => {
      this.toggleFullscreenInApp();
    });

    this.dom.videoWrapper.addEventListener("dblclick", () => {
      this.toggleFullscreenInApp();
    });

    this.dom.btnReconnect.addEventListener("click", () => {
      this.reconnectNow();
    });

    this.dom.video.addEventListener("loadedmetadata", () => this._updateVideoWrapperAspectRatio());
    this.dom.video.addEventListener("resize", () => this._updateVideoWrapperAspectRatio());
  }

  setStatus(state, subText) {
    this.dom.status.classList.remove("online", "offline", "connecting", "not-ready");
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
      this.dom.statusText.textContent = "未连接";
      this.isConnected = false;
    }
  }

  async connect() {
    this.clearReconnectTimer();
    this.stopStatsTimer();
    this.closePeer();

    const cfg = getEffectiveSettings();
    const url = buildWhepUrl(cfg.webrtcBase, this.camera.path);
    if (!url) return;

    this.setStatus("connecting");
    this.isConnected = false;

    const pc = new RTCPeerConnection();
    this.pc = pc;

    const stream = new MediaStream();
    this.stream = stream;
    this.dom.video.srcObject = stream;

    pc.ontrack = (evt) => {
      evt.streams[0].getTracks().forEach((t) => {
        if (!stream.getTracks().includes(t)) {
          stream.addTrack(t);
        }
      });
      if (evt.track.kind === "video") {
        this.dom.video.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState;
      if (cs === "connected") {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.setStatus("online");
        this.startStatsTimer();
      } else if (cs === "failed" || cs === "disconnected") {
        this.isConnected = false;
        this.setStatus("offline");
        this.stopStatsTimer();
        this.reconnectAttempts += 1;
        const delay = Math.min(5000 + this.reconnectAttempts * 3000, 25000);
        this.scheduleReconnect(delay);
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIceGatheringComplete(pc, 2000);

      const localSdp = pc.localDescription ? pc.localDescription.sdp : offer.sdp;
      // 不注入 H.265：Chromium 在 setLocalDescription/setRemoteDescription 时不接受与 offer 不一致的 H.265，会导致报错；仅用浏览器原生 offer，H.264 流可正常出画面，H.265 流会返回 400 并提示编码不支持
      const bodySdp = localSdp;

      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          mode: "cors",
          headers: {
            "Content-Type": "application/sdp",
            Accept: "application/sdp",
          },
          body: bodySdp,
        });
      } catch (fetchErr) {
        console.error(`[${this.camera.name || this.camera.path}] WHEP fetch 异常:`, fetchErr?.message || fetchErr);
        throw fetchErr;
      }

      if (!res.ok) {
        const body = await res.text();
        const isCodecError = res.status === 400 && /codecs?\s+not\s+supported/i.test(body);
        if (isCodecError) {
          this.setStatus("not_ready", "编码不被浏览器支持");
          this.dom.status.title = "当前路径为 H.265 源，本端无法直接解码。请在 MediaMTX 中为该路径配置 runOnDemand/FFmpeg 将 H.265 转成 H.264，前端连接转码后的路径（如 cam1 而非 cam1_raw）。参考项目根目录 mediamtx.yml 示例。";
          console.warn(`[${this.camera.name || this.camera.path}] 编码不支持: 需 H264 等浏览器支持的编码，当前源可能为 H265/其他。`);
          this.reconnectAttempts += 1;
          const delay = Math.min(15000 + this.reconnectAttempts * 5000, 60000);
          this.scheduleReconnect(delay);
          return;
        }
        if (res.status === 404) {
          this.setStatus("not_ready", "流未就绪（RTSP 未接通）");
          this.dom.status.title = "后端路径存在但无流，请检查设置中的 RTSP 地址与摄像头/网络";
          console.error(`[${this.camera.name || this.camera.path}] WHEP 404`, body?.slice(0, 200) || "");
          this.reconnectAttempts += 1;
          const delay = Math.min(8000 + this.reconnectAttempts * 4000, 30000);
          this.scheduleReconnect(delay);
          return;
        }
        console.error(`[${this.camera.name || this.camera.path}] WHEP 请求失败: ${res.status} ${res.statusText}`, body?.slice(0, 200) || "");
        throw new Error(`WHEP 请求失败: ${res.status}`);
      }

      let answerSdp = await res.text();
      if (!answerSdp || !answerSdp.includes("v=")) {
        console.error(`[${this.camera.name || this.camera.path}] 无效的 SDP 应答`, answerSdp?.slice(0, 200));
        throw new Error("无效的 SDP 应答");
      }
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answerSdp }));
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[${this.camera.name || this.camera.path}] WebRTC 连接错误:`, msg);
      this.setStatus("offline");
      this.reconnectAttempts += 1;
      const delay = Math.min(3000 + this.reconnectAttempts * 2000, 20000);
      this.scheduleReconnect(delay);
    }
  }

  async waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") return;
    let resolveFn;
    const p = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolveFn();
    }, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolveFn();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    await p;
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

  startStatsTimer() {
    this.stopStatsTimer();
    if (!this.pc) return;
    this.statsTimer = setInterval(async () => {
      try {
        const report = await this.pc.getStats();
        let videoInbound = null;
        report.forEach((stat) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") {
            videoInbound = stat;
          }
        });
        if (!videoInbound) return;

        const now = performance.now();
        const prev = this.lastVideoStats;
        let fps = videoInbound.framesPerSecond;
        if (!fps && prev && prev.framesDecoded != null && videoInbound.framesDecoded != null) {
          const deltaFrames = videoInbound.framesDecoded - prev.framesDecoded;
          const deltaTime = (now - prev.timestamp) / 1000;
          fps = deltaTime > 0 ? deltaFrames / deltaTime : 0;
        }
        const packetsLost = videoInbound.packetsLost || 0;
        const packetsReceived = videoInbound.packetsReceived || 0;
        const totalPackets = packetsLost + packetsReceived;
        const lossRate = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;
        const rtt = videoInbound.roundTripTime || 0;

        this.dom.statsText.textContent = `FPS: ${fps ? fps.toFixed(1) : "-"}  丢包: ${lossRate.toFixed(1)}%  RTT: ${Math.round(rtt * 1000) || 0}ms`;
        this.lastVideoStats = { framesDecoded: videoInbound.framesDecoded, timestamp: now };
      } catch (e) {
        // 忽略临时统计错误
      }
    }, 2000);
  }

  stopStatsTimer() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  toggleFullscreenInApp() {
    const card = this.containerEl;
    const isFull = card.classList.contains("fullscreen-mode");
    if (isFull) {
      card.classList.remove("fullscreen-mode");
      document.body.style.overflow = "";
    } else {
      card.classList.add("fullscreen-mode");
      document.body.style.overflow = "hidden";
    }
  }

  async singleScreenshot(batchTimestamp) {
    const video = this.dom.video;
    if (!video.videoWidth || !video.videoHeight) return;
    const ts = batchTimestamp || Date.now();
    const { date, time } = formatTimestamp(ts);

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // 使用 JPEG 有损压缩，体积更小（质量 0.92）
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    const dir = `${date}/${time}`;
    const fileName = `${this.camera.name || this.camera.path}_${ts}.jpg`;
    const fullPath = `${dir}/${fileName}`;

    if (window.electronAPI) {
      return { relativePath: fullPath, dataUrl };
    }
    await saveImageToPath(fullPath, dataUrl);
  }

  closePeer() {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.isConnected = false;
  }

  destroy() {
    this.clearReconnectTimer();
    this.stopStatsTimer();
    this.closePeer();
    this.containerEl.innerHTML = "";
  }
}
