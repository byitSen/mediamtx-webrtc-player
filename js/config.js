const STORAGE_KEY = "mediamtx-webrtc-player-settings";

function getDefaultSettings() {
  return {
    webrtcBase: "http://localhost:8889",
    gridColumns: 3,
    maxActiveConnections: 8,
    cameras: [{ name: "摄像头1", path: "cam1" }],
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultSettings();
    const parsed = JSON.parse(raw);
    return { ...getDefaultSettings(), ...parsed };
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

export function buildWhepUrl(webrtcBase, cameraPath) {
  const base = (webrtcBase || "").replace(/\/$/, "");
  return `${base}/${cameraPath}/whep`;
}
