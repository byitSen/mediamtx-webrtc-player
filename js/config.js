const STORAGE_KEY = "mediamtx-webrtc-player-settings";

function getDefaultSettings() {
  return {
    gridColumns: 2,
    maxActiveConnections: 8,
    lockFpsEnabled: true,
    lockFps: 25,
    cameras: [{ name: "摄像头1", rtspUrl: "rtsp://127.0.0.1:554/stream1" }],
    windowWidth: 1020,
    windowHeight: 820,
    fullscreenWidth: 1240,
    fullscreenHeight: 800,
    screenshotShortcut: "CommandOrControl+Shift+S",
    memoryWatchEnabled: false,
    memoryWatchProcessName: "weight.exe",
    memoryWatchModuleOffset: "0x9B27E0",
    memoryWatchOffsets: ["0x5EC", "0x310", "0x504", "0x94", "0x4DC"],
    memoryWatchPointerSize: 8,
  };
}

function normalizeLockFps(settings) {
  const enabled = settings.lockFpsEnabled !== false;
  let fps = parseInt(settings.lockFps, 10);
  if (!Number.isFinite(fps)) fps = 25;
  fps = Math.max(1, Math.min(60, fps));
  settings.lockFpsEnabled = enabled;
  settings.lockFps = fps;
  return settings;
}

function migrateCameras(cameras) {
  if (!Array.isArray(cameras)) return getDefaultSettings().cameras;
  return cameras.map((c) => {
    const name = c?.name || "未命名";
    const rtspUrl = (c?.rtspUrl || "").trim();
    if (rtspUrl) return { name, rtspUrl };
    // 旧版 path 仅作显示后备，无法直接播放
    const path = (c?.path || "").trim();
    return { name, rtspUrl: path.startsWith("rtsp") ? path : "", path: path || undefined };
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
    return normalizeLockFps(merged);
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
