const STORAGE_KEY = "mediamtx-webrtc-player-settings";

function getDefaultSettings() {
  return {
    gridColumns: 2,
    maxActiveConnections: 8,
    cameras: [{ name: "摄像头1", rtspUrl: "rtsp://127.0.0.1:554/stream1" }],
    windowWidth: 1020,
    windowHeight: 820,
    screenshotShortcut: "CommandOrControl+Shift+S",
    memoryWatchEnabled: false,
    memoryWatchProcessName: "weight.exe",
    // [[[[[[["weight.exe"+9B8568]+504]+434]+4]+310]+5EC]  32 位指针
    memoryWatchModuleOffset: "0x9B8568",
    memoryWatchOffsets: ["0x504", "0x434", "0x4", "0x310", "0x5EC"],
    memoryWatchPointerSize: 4,
    memoryWatchTriggerValue: 0,
    // MSE 协商优先编码：h265 | h264
    preferredVideoCodec: "h265",
    // 拉流方式：rtsp=应用自动注册 | go2rtc=使用 Web 里配置的流名
    streamSource: "rtsp",
  };
}

function migrateCameras(cameras) {
  if (!Array.isArray(cameras)) return getDefaultSettings().cameras;
  return cameras.map((c) => {
    const name = c?.name || "未命名";
    const rtspUrl = (c?.rtspUrl || "").trim();
    const go2rtcSrc = (c?.go2rtcSrc || "").trim();
    // 旧版 path 仅作显示后备
    const path = (c?.path || "").trim();
    const migratedRtsp =
      rtspUrl || (path.startsWith("rtsp") ? path : "");
    return {
      name,
      rtspUrl: migratedRtsp,
      go2rtcSrc: go2rtcSrc || undefined,
      path: path && !path.startsWith("rtsp") ? path : undefined,
    };
  });
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultSettings();
    const parsed = JSON.parse(raw);
    const merged = { ...getDefaultSettings(), ...parsed };
    merged.cameras = migrateCameras(merged.cameras);
    if (merged.maxActiveConnections > 16) merged.maxActiveConnections = 16;
    delete merged.lockFpsEnabled;
    delete merged.lockFps;
    delete merged.fullscreenWidth;
    delete merged.fullscreenHeight;
    // 旧默认链迁移到新默认：weight.exe+0x9B8568 → … → 0x5EC（32 位）
    const oldDefaultOffsets = ["0x5EC", "0x310", "0x504", "0x94", "0x4DC"];
    const offsetsEqual =
      Array.isArray(merged.memoryWatchOffsets) &&
      merged.memoryWatchOffsets.length === oldDefaultOffsets.length &&
      merged.memoryWatchOffsets.every((v, i) => String(v).toLowerCase() === oldDefaultOffsets[i].toLowerCase());
    if (
      (merged.memoryWatchModuleOffset === "0x9B27E0" || merged.memoryWatchModuleOffset === "0x9b27e0") &&
      offsetsEqual
    ) {
      const d = getDefaultSettings();
      merged.memoryWatchModuleOffset = d.memoryWatchModuleOffset;
      merged.memoryWatchOffsets = [...d.memoryWatchOffsets];
      merged.memoryWatchPointerSize = d.memoryWatchPointerSize;
    }
    if (merged.memoryWatchTriggerValue === undefined || merged.memoryWatchTriggerValue === null) {
      merged.memoryWatchTriggerValue = 0;
    }
    const codec = String(merged.preferredVideoCodec || "h265").toLowerCase();
    merged.preferredVideoCodec = codec === "h264" ? "h264" : "h265";
    delete merged.rtspTransport;
    const src = String(merged.streamSource || "rtsp").toLowerCase();
    merged.streamSource = src === "go2rtc" ? "go2rtc" : "rtsp";
    return merged;
  } catch (e) {
    console.warn("loadSettings error", e);
    return getDefaultSettings();
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn("saveSettings error", e);
  }
}

export function getEffectiveSettings() {
  return loadSettings();
}
