import { loadSettings, saveSettings, getEffectiveSettings } from "./config.js";
import { initPlayers, getPlayerInstances, applyGridColumns } from "./layout.js";
import { setMaxActiveConnections } from "./webrtc-pool.js";
import { dataUrlToBase64 } from "./utils.js";
import { installDesktopGlobals, isDesktopEnv } from "./desktop.js";

const SCREENSHOT_INTERVAL_MS = 200;
const DESKTOP_SAVE_DIR_KEY = "desktop_screenshot_dir";
const TOAST_DURATION_MS = 2500;

let batchScreenshotInProgress = false;

function setBatchScreenshotBusy(busy) {
  batchScreenshotInProgress = busy;
  if (batchScreenshotBtn) {
    batchScreenshotBtn.disabled = busy;
    batchScreenshotBtn.setAttribute("aria-busy", busy ? "true" : "false");
    batchScreenshotBtn.title = busy ? "截图进行中，请稍候…" : "";
  }
}

function showToast(message) {
  const el = document.createElement("div");
  el.className = "toast-message";
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast-visible"));
  setTimeout(() => {
    el.classList.remove("toast-visible");
    setTimeout(() => el.remove(), 300);
  }, TOAST_DURATION_MS);
}

const playersGrid = document.getElementById("playersGrid");
const batchScreenshotBtn = document.getElementById("batchScreenshotBtn");
const memoryDebugBtn = document.getElementById("memoryDebugBtn");
const memoryDebugPanel = document.getElementById("memoryDebugPanel");
const memoryDebugLog = document.getElementById("memoryDebugLog");
const memoryDebugClearBtn = document.getElementById("memoryDebugClearBtn");
const memoryDebugCloseBtn = document.getElementById("memoryDebugCloseBtn");
const saveDirDisplay = document.getElementById("saveDirDisplay");

const MEMORY_DEBUG_MAX_LINES = 400;

const settingsOverlay = document.getElementById("settingsOverlay");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");
const settingsSaveBtn = document.getElementById("settingsSaveBtn");
const settingGridColumns = document.getElementById("settingGridColumns");
const settingMaxActive = document.getElementById("settingMaxActive");
const settingCamerasList = document.getElementById("settingCamerasList");
const settingAddCamera = document.getElementById("settingAddCamera");
const settingsBtn = document.getElementById("settingsBtn");

const settingWindowSizeSection = document.getElementById("settingWindowSizeSection");
const settingWindowPreset = document.getElementById("settingWindowPreset");
const settingWindowWidth = document.getElementById("settingWindowWidth");
const settingWindowHeight = document.getElementById("settingWindowHeight");
const settingWindowWidthSlider = document.getElementById("settingWindowWidthSlider");
const settingWindowHeightSlider = document.getElementById("settingWindowHeightSlider");
const settingFullscreenWidth = document.getElementById("settingFullscreenWidth");
const settingFullscreenHeight = document.getElementById("settingFullscreenHeight");
const settingFullscreenWidthSlider = document.getElementById("settingFullscreenWidthSlider");
const settingFullscreenHeightSlider = document.getElementById("settingFullscreenHeightSlider");
const settingScreenshotShortcut = document.getElementById("settingScreenshotShortcut");
const settingMemoryWatchSection = document.getElementById("settingMemoryWatchSection");
const settingMemoryWatchEnabled = document.getElementById("settingMemoryWatchEnabled");
const settingMemoryWatchProcessName = document.getElementById("settingMemoryWatchProcessName");
const settingMemoryWatchModuleOffset = document.getElementById("settingMemoryWatchModuleOffset");
const settingMemoryWatchPointerSize = document.getElementById("settingMemoryWatchPointerSize");
const settingMemoryWatchOffsetsList = document.getElementById("settingMemoryWatchOffsetsList");
const settingAddMemoryOffset = document.getElementById("settingAddMemoryOffset");
const settingMemoryWatchHint = document.getElementById("settingMemoryWatchHint");

const DEFAULT_MEMORY_OFFSETS = ["0x5EC", "0x310", "0x504", "0x94", "0x4DC"];
const WINDOW_WIDTH_MIN = 520;
const WINDOW_WIDTH_MAX = 3840;
const WINDOW_HEIGHT_MIN = 420;
const WINDOW_HEIGHT_MAX = 2160;

function renderCameraRow(name = "", rtspUrl = "", index = 0) {
  if (!settingCamerasList) return;
  const row = document.createElement("div");
  row.className = "camera-row";
  row.dataset.index = String(index);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "名称";
  nameInput.value = name;

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "rtsp://127.0.0.1:554/stream1";
  urlInput.value = rtspUrl;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-remove";
  removeBtn.textContent = "删除";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(urlInput);
  row.appendChild(removeBtn);
  settingCamerasList.appendChild(row);
}

function renderOffsetRow(value = "") {
  if (!settingMemoryWatchOffsetsList) return;
  const row = document.createElement("div");
  row.className = "offset-row";

  const offsetInput = document.createElement("input");
  offsetInput.type = "text";
  offsetInput.placeholder = "0x0";
  offsetInput.value = value;
  offsetInput.maxLength = 32;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-remove";
  removeBtn.textContent = "删除";
  removeBtn.addEventListener("click", () => {
    const rows = settingMemoryWatchOffsetsList.querySelectorAll(".offset-row");
    if (rows.length <= 1) return;
    row.remove();
  });

  row.appendChild(offsetInput);
  row.appendChild(removeBtn);
  settingMemoryWatchOffsetsList.appendChild(row);
}

function collectMemoryWatchOffsets() {
  const offsets = [];
  settingMemoryWatchOffsetsList?.querySelectorAll(".offset-row input").forEach((input) => {
    const v = (input.value || "").trim();
    if (v) offsets.push(v);
  });
  return offsets.length ? offsets : [...DEFAULT_MEMORY_OFFSETS];
}

function buildMemoryWatchConfig(cfg) {
  const ptr = Number(cfg.memoryWatchPointerSize);
  return {
    enabled: !!cfg.memoryWatchEnabled,
    processName: (cfg.memoryWatchProcessName || "").trim(),
    moduleOffset: (cfg.memoryWatchModuleOffset || "").trim() || "0x0",
    offsets: Array.isArray(cfg.memoryWatchOffsets) && cfg.memoryWatchOffsets.length
      ? cfg.memoryWatchOffsets
      : [...DEFAULT_MEMORY_OFFSETS],
    pointerSize: ptr === 4 || ptr === 8 || ptr === 0 ? ptr : 8,
  };
}

function applyMemoryWatchConfig(cfg) {
  if (!isElectronEnv() || !window.electronAPI.configureMemoryWatch) return;
  window.electronAPI.configureMemoryWatch(buildMemoryWatchConfig(cfg));
}

function updateMemoryWatchSectionAvailability() {
  if (!settingMemoryWatchSection) return;
  const isDesktop = isElectronEnv();
  const isWin = isDesktop && window.electronAPI.platform === "win32";
  settingMemoryWatchSection.style.display = isDesktop ? "" : "none";
  const controls = settingMemoryWatchSection.querySelectorAll("input, button, select");
  controls.forEach((el) => {
    el.disabled = !isWin;
  });
  if (settingMemoryWatchHint) {
    settingMemoryWatchHint.textContent = isWin
      ? "仅 Windows 桌面版有效；64 位进程请选「64 位指针」；监控值变为 0 时截图一次，恢复非 0 后重新武装。"
      : isDesktop
        ? "当前系统非 Windows，内存监控不可用。"
        : "仅 Windows 桌面版可用。";
  }
}

function openSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.remove("hidden");
  settingsOverlay.setAttribute("aria-hidden", "false");

  const cfg = getEffectiveSettings();
  const gridColumns = cfg.gridColumns || 2;
  const maxActive = Math.min(16, cfg.maxActiveConnections || 8);
  const cameras =
    cfg.cameras && cfg.cameras.length
      ? cfg.cameras
      : [{ name: "摄像头1", rtspUrl: "rtsp://127.0.0.1:554/stream1" }];

  if (settingGridColumns) settingGridColumns.value = String(gridColumns);
  if (settingMaxActive) settingMaxActive.value = String(maxActive);

  if (settingCamerasList) {
    settingCamerasList.innerHTML = "";
    cameras.forEach((c, i) => renderCameraRow(c.name, c.rtspUrl || "", i));
  }

  const winW = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, cfg.windowWidth ?? 1020));
  const winH = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, cfg.windowHeight ?? 820));
  if (settingWindowWidth) settingWindowWidth.value = String(winW);
  if (settingWindowHeight) settingWindowHeight.value = String(winH);
  if (settingWindowWidthSlider) settingWindowWidthSlider.value = String(winW);
  if (settingWindowHeightSlider) settingWindowHeightSlider.value = String(winH);
  if (settingWindowPreset) updateWindowPresetFromSize(winW, winH);

  const fsW = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, cfg.fullscreenWidth ?? 1240));
  const fsH = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, cfg.fullscreenHeight ?? 800));
  if (settingFullscreenWidth) settingFullscreenWidth.value = String(fsW);
  if (settingFullscreenHeight) settingFullscreenHeight.value = String(fsH);
  if (settingFullscreenWidthSlider) settingFullscreenWidthSlider.value = String(fsW);
  if (settingFullscreenHeightSlider) settingFullscreenHeightSlider.value = String(fsH);
  if (settingScreenshotShortcut) settingScreenshotShortcut.value = cfg.screenshotShortcut ?? "CommandOrControl+Shift+S";

  if (settingMemoryWatchEnabled) settingMemoryWatchEnabled.checked = !!cfg.memoryWatchEnabled;
  if (settingMemoryWatchProcessName) {
    settingMemoryWatchProcessName.value = cfg.memoryWatchProcessName ?? "weight.exe";
  }
  if (settingMemoryWatchModuleOffset) {
    settingMemoryWatchModuleOffset.value = cfg.memoryWatchModuleOffset ?? "0x9B27E0";
  }
  if (settingMemoryWatchPointerSize) {
    const ptr = Number(cfg.memoryWatchPointerSize);
    settingMemoryWatchPointerSize.value = String(ptr === 4 || ptr === 8 || ptr === 0 ? ptr : 8);
  }
  if (settingMemoryWatchOffsetsList) {
    settingMemoryWatchOffsetsList.innerHTML = "";
    const offsets =
      Array.isArray(cfg.memoryWatchOffsets) && cfg.memoryWatchOffsets.length
        ? cfg.memoryWatchOffsets
        : DEFAULT_MEMORY_OFFSETS;
    offsets.forEach((off) => renderOffsetRow(off));
  }

  if (settingWindowSizeSection) {
    settingWindowSizeSection.style.display = isElectronEnv() ? "" : "none";
  }
  updateMemoryWatchSectionAvailability();

  updateSaveDirDisplay();
}

function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.add("hidden");
  settingsOverlay.setAttribute("aria-hidden", "true");
}

function updateWindowPresetFromSize(w, h) {
  if (!settingWindowPreset) return;
  const v = `${w}x${h}`;
  const opt = Array.from(settingWindowPreset.options).find((o) => o.value === v);
  settingWindowPreset.value = opt ? opt.value : "custom";
}

function applyWindowPreset(value) {
  if (!value || value === "custom") return;
  const [w, h] = value.split("x").map((n) => parseInt(n, 10));
  if (!w || !h) return;
  const nw = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, w));
  const nh = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, h));
  if (settingWindowWidth) settingWindowWidth.value = String(nw);
  if (settingWindowHeight) settingWindowHeight.value = String(nh);
  if (settingWindowWidthSlider) settingWindowWidthSlider.value = String(nw);
  if (settingWindowHeightSlider) settingWindowHeightSlider.value = String(nh);
}

function addCameraRow() {
  const list = settingCamerasList?.querySelectorAll(".camera-row") || [];
  renderCameraRow("", "", list.length);
}

function addMemoryOffsetRow() {
  renderOffsetRow("");
}

function saveSettingsFromForm() {
  const cameras = [];
  settingCamerasList?.querySelectorAll(".camera-row").forEach((row) => {
    const inputs = row.querySelectorAll("input");
    const name = (inputs[0]?.value || "").trim();
    const rtspUrl = (inputs[1]?.value || "").trim();
    if (rtspUrl) cameras.push({ name: name || "未命名", rtspUrl });
  });
  if (!cameras.length) cameras.push({ name: "摄像头1", rtspUrl: "rtsp://127.0.0.1:554/stream1" });

  const current = loadSettings();
  const gridColumns = Math.max(1, Math.min(4, parseInt(settingGridColumns?.value || "2", 10) || 2));
  const maxActive = Math.max(1, Math.min(16, parseInt(settingMaxActive?.value || "8", 10) || 8));
  const windowWidth = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingWindowWidth?.value || "1020", 10) || 1020));
  const windowHeight = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingWindowHeight?.value || "820", 10) || 820));
  const fullscreenWidth = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingFullscreenWidth?.value || "1240", 10) || 1240));
  const fullscreenHeight = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingFullscreenHeight?.value || "800", 10) || 800));
  const screenshotShortcut = (settingScreenshotShortcut?.value || "").trim();
  const memoryWatchEnabled = !!settingMemoryWatchEnabled?.checked;
  const memoryWatchProcessName = (settingMemoryWatchProcessName?.value || "").trim() || "weight.exe";
  const memoryWatchModuleOffset = (settingMemoryWatchModuleOffset?.value || "").trim() || "0x9B27E0";
  const memoryWatchPointerSizeRaw = Number(settingMemoryWatchPointerSize?.value);
  const memoryWatchPointerSize =
    memoryWatchPointerSizeRaw === 4 || memoryWatchPointerSizeRaw === 8 || memoryWatchPointerSizeRaw === 0
      ? memoryWatchPointerSizeRaw
      : 8;
  const memoryWatchOffsets = collectMemoryWatchOffsets();

  const next = {
    ...current,
    cameras,
    gridColumns,
    maxActiveConnections: maxActive,
    windowWidth,
    windowHeight,
    fullscreenWidth,
    fullscreenHeight,
    screenshotShortcut: screenshotShortcut || undefined,
    memoryWatchEnabled,
    memoryWatchProcessName,
    memoryWatchModuleOffset,
    memoryWatchPointerSize,
    memoryWatchOffsets,
  };
  delete next.webrtcBase;
  delete next.lockFpsEnabled;
  delete next.lockFps;
  saveSettings(next);

  if (isElectronEnv()) {
    if (window.electronAPI.setWindowSize) window.electronAPI.setWindowSize(windowWidth, windowHeight);
    if (window.electronAPI.registerScreenshotShortcut) window.electronAPI.registerScreenshotShortcut(screenshotShortcut || null);
    applyMemoryWatchConfig(next);
  }

  setMaxActiveConnections(maxActive);
  applyGridColumns(playersGrid, gridColumns);
  initPlayers(playersGrid, next.cameras);
  closeSettings();
}

async function batchScreenshot() {
  const players = getPlayerInstances();
  if (!players.length) return;
  if (batchScreenshotInProgress) return;

  if (isElectronEnv()) {
    let baseDir = localStorage.getItem(DESKTOP_SAVE_DIR_KEY);
    if (!baseDir) {
      baseDir = await window.electronAPI.chooseSaveDir();
      if (baseDir) localStorage.setItem(DESKTOP_SAVE_DIR_KEY, baseDir);
    }
    if (!baseDir) return;
  }

  setBatchScreenshotBusy(true);
  const ts = Date.now();

  try {
    if (isElectronEnv()) {
      const baseDir = localStorage.getItem(DESKTOP_SAVE_DIR_KEY);
      let success = 0;
      let lastError = "";
      for (const p of players) {
        if (p.isConnected) {
          try {
            const result = await p.singleScreenshot(ts);
            if (result?.relativePath && result?.dataUrl) {
              const base64Png = dataUrlToBase64(result.dataUrl);
              const res = await window.electronAPI.saveScreenshot({
                baseDir,
                relativePath: result.relativePath,
                base64Png,
              });
              if (res?.ok !== false) success += 1;
              else lastError = res?.message || "保存失败";
            } else {
              lastError = "画面尚未就绪";
            }
            await new Promise((r) => setTimeout(r, SCREENSHOT_INTERVAL_MS));
          } catch (e) {
            console.error("batch screenshot error", e);
            lastError = e?.message || String(e);
          }
        }
      }
      if (success > 0) {
        showToast(`已保存 ${success} 张截图到所选目录`);
        updateSaveDirDisplay();
        await new Promise((r) => setTimeout(r, TOAST_DURATION_MS));
      } else {
        showToast(lastError || "没有可截图的在线画面");
        await new Promise((r) => setTimeout(r, TOAST_DURATION_MS));
      }
      return;
    }

    let success = 0;
    for (const p of players) {
      if (p.isConnected) {
        try {
          await p.singleScreenshot(ts);
          success += 1;
          await new Promise((r) => setTimeout(r, SCREENSHOT_INTERVAL_MS));
        } catch (e) {
          console.error("batch screenshot error", e);
        }
      }
    }
    if (success > 0) {
      showToast(`已为 ${success} 路摄像头完成截图`);
      await new Promise((r) => setTimeout(r, TOAST_DURATION_MS));
    } else {
      showToast("没有可截图的在线画面");
      await new Promise((r) => setTimeout(r, TOAST_DURATION_MS));
    }
  } finally {
    setBatchScreenshotBusy(false);
  }
}

function updateSaveDirDisplay() {
  const isDesktop = isElectronEnv();
  const dir = isDesktop ? localStorage.getItem(DESKTOP_SAVE_DIR_KEY) : null;
  if (saveDirDisplay) {
    if (isDesktop) {
      saveDirDisplay.textContent = dir
        ? `截图保存到：${dir}`
        : "在设置中选择保存目录后，使用一键截图。";
    } else {
      saveDirDisplay.textContent =
        "浏览器环境无法本地拉 RTSP，请使用桌面版；截图仍可保存到下载目录。";
    }
  }
  const settingSaveDirPath = document.getElementById("settingSaveDirPath");
  const chooseSaveDirBtn = document.getElementById("chooseSaveDirBtn");
  if (settingSaveDirPath) {
    settingSaveDirPath.textContent = isDesktop ? (dir || "未设置") : "仅桌面版可用";
    settingSaveDirPath.style.cursor = isDesktop ? "pointer" : "";
    settingSaveDirPath.title = isDesktop ? "点击选择目录" : "";
  }
  if (chooseSaveDirBtn) {
    chooseSaveDirBtn.disabled = !isDesktop;
    chooseSaveDirBtn.title = isDesktop ? "打开目录选择" : "仅桌面版可用";
  }
}

function isElectronEnv() {
  if (typeof window === "undefined") return false;
  return isDesktopEnv() || !!window.electronAPI;
}

function formatDebugTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function appendMemoryDebugLog(entry) {
  if (!memoryDebugLog || !entry) return;
  const level = entry.level || "info";
  const line = document.createElement("div");
  line.className = `log-${level}`;
  const detail =
    entry.detail && typeof entry.detail === "object"
      ? " " + JSON.stringify(entry.detail)
      : "";
  line.textContent = `[${formatDebugTime(entry.ts)}] [${level}] ${entry.message || ""}${detail}`;
  memoryDebugLog.appendChild(line);
  while (memoryDebugLog.childElementCount > MEMORY_DEBUG_MAX_LINES) {
    memoryDebugLog.removeChild(memoryDebugLog.firstChild);
  }
  memoryDebugLog.scrollTop = memoryDebugLog.scrollHeight;
}

function openMemoryDebugPanel() {
  if (!memoryDebugPanel) return;
  memoryDebugPanel.classList.remove("hidden");
  memoryDebugPanel.setAttribute("aria-hidden", "false");
}

function closeMemoryDebugPanel() {
  if (!memoryDebugPanel) return;
  memoryDebugPanel.classList.add("hidden");
  memoryDebugPanel.setAttribute("aria-hidden", "true");
}

function toggleMemoryDebugPanel() {
  if (!memoryDebugPanel) return;
  if (memoryDebugPanel.classList.contains("hidden")) openMemoryDebugPanel();
  else closeMemoryDebugPanel();
}

function setupMemoryDebugUi() {
  const showBtn = isElectronEnv() && window.electronAPI.platform === "win32";
  if (memoryDebugBtn) {
    memoryDebugBtn.style.display = showBtn ? "" : "none";
    memoryDebugBtn.addEventListener("click", toggleMemoryDebugPanel);
  }
  if (memoryDebugClearBtn) {
    memoryDebugClearBtn.addEventListener("click", () => {
      if (memoryDebugLog) memoryDebugLog.innerHTML = "";
    });
  }
  if (memoryDebugCloseBtn) memoryDebugCloseBtn.addEventListener("click", closeMemoryDebugPanel);
  if (isElectronEnv()) {
    window.addEventListener("memory-watch-log", (ev) => {
      appendMemoryDebugLog(ev.detail);
    });
  }
}

async function resolveAppVersion() {
  if (isElectronEnv() && window.electronAPI.getAppVersion) {
    try {
      const v = await window.electronAPI.getAppVersion();
      if (v) return String(v);
    } catch (_) {}
  }
  try {
    const res = await fetch("./package.json", { cache: "no-store" });
    if (res.ok) {
      const pkg = await res.json();
      if (pkg?.version) return String(pkg.version);
    }
  } catch (_) {}
  return "";
}

async function showAppVersion() {
  const el = document.getElementById("appVersion");
  if (!el) return;
  const version = await resolveAppVersion();
  if (!version) {
    el.textContent = "";
    return;
  }
  el.textContent = `v${version}`;
  el.title = `版本 ${version}`;
}

async function chooseSaveDir() {
  if (!isElectronEnv()) return;
  try {
    const baseDir = await window.electronAPI.chooseSaveDir();
    if (baseDir) {
      localStorage.setItem(DESKTOP_SAVE_DIR_KEY, baseDir);
      updateSaveDirDisplay();
    }
  } catch (e) {
    console.error("选择保存目录失败", e);
  }
}

function setupGlobalControls() {
  if (batchScreenshotBtn) batchScreenshotBtn.addEventListener("click", batchScreenshot);
  if (settingsBtn) settingsBtn.addEventListener("click", openSettings);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettings);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener("click", closeSettings);
  if (settingsSaveBtn) settingsSaveBtn.addEventListener("click", saveSettingsFromForm);
  if (settingAddCamera) settingAddCamera.addEventListener("click", addCameraRow);
  if (settingAddMemoryOffset) settingAddMemoryOffset.addEventListener("click", addMemoryOffsetRow);

  const chooseSaveDirBtn = document.getElementById("chooseSaveDirBtn");
  const settingSaveDirPath = document.getElementById("settingSaveDirPath");
  if (chooseSaveDirBtn) chooseSaveDirBtn.addEventListener("click", chooseSaveDir);
  if (settingSaveDirPath) {
    settingSaveDirPath.addEventListener("click", () => {
      if (isElectronEnv()) chooseSaveDir();
    });
  }

  if (settingWindowWidthSlider && settingWindowWidth) {
    settingWindowWidthSlider.addEventListener("input", () => {
      settingWindowWidth.value = settingWindowWidthSlider.value;
      updateWindowPresetFromSize(parseInt(settingWindowWidthSlider.value, 10), parseInt(settingWindowHeight?.value || "820", 10));
    });
  }
  if (settingWindowWidth && settingWindowWidthSlider) {
    settingWindowWidth.addEventListener("input", () => {
      const v = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingWindowWidth.value, 10) || 1020));
      settingWindowWidth.value = String(v);
      settingWindowWidthSlider.value = String(v);
      updateWindowPresetFromSize(v, parseInt(settingWindowHeight?.value || "820", 10));
    });
  }
  if (settingWindowHeightSlider && settingWindowHeight) {
    settingWindowHeightSlider.addEventListener("input", () => {
      settingWindowHeight.value = settingWindowHeightSlider.value;
      updateWindowPresetFromSize(parseInt(settingWindowWidth?.value || "1020", 10), parseInt(settingWindowHeightSlider.value, 10));
    });
  }
  if (settingWindowHeight && settingWindowHeightSlider) {
    settingWindowHeight.addEventListener("input", () => {
      const v = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingWindowHeight.value, 10) || 820));
      settingWindowHeight.value = String(v);
      settingWindowHeightSlider.value = String(v);
      updateWindowPresetFromSize(parseInt(settingWindowWidth?.value || "1020", 10), v);
    });
  }
  if (settingWindowPreset) {
    settingWindowPreset.addEventListener("change", () => applyWindowPreset(settingWindowPreset.value));
  }

  if (settingFullscreenWidthSlider && settingFullscreenWidth) {
    settingFullscreenWidthSlider.addEventListener("input", () => {
      settingFullscreenWidth.value = settingFullscreenWidthSlider.value;
    });
  }
  if (settingFullscreenWidth && settingFullscreenWidthSlider) {
    settingFullscreenWidth.addEventListener("input", () => {
      const v = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingFullscreenWidth.value, 10) || 1240));
      settingFullscreenWidth.value = String(v);
      settingFullscreenWidthSlider.value = String(v);
    });
  }
  if (settingFullscreenHeightSlider && settingFullscreenHeight) {
    settingFullscreenHeightSlider.addEventListener("input", () => {
      settingFullscreenHeight.value = settingFullscreenHeightSlider.value;
    });
  }
  if (settingFullscreenHeight && settingFullscreenHeightSlider) {
    settingFullscreenHeight.addEventListener("input", () => {
      const v = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingFullscreenHeight.value, 10) || 800));
      settingFullscreenHeight.value = String(v);
      settingFullscreenHeightSlider.value = String(v);
    });
  }

  if (settingWindowSizeSection) {
    settingWindowSizeSection.style.display = isElectronEnv() ? "" : "none";
  }
  updateMemoryWatchSectionAvailability();

  updateSaveDirDisplay();
}

window.addEventListener("load", async () => {
  await installDesktopGlobals();
  // 异步校正 platform（Windows 内存调试按钮）
  if (window.desktopAPI?.getPlatform) {
    try {
      const p = await window.desktopAPI.getPlatform();
      if (window.electronAPI) {
        Object.defineProperty(window.electronAPI, "platform", { get: () => (p === "windows" ? "win32" : p === "macos" ? "darwin" : p) });
      }
    } catch (_) {}
  }
  setupGlobalControls();
  setupMemoryDebugUi();
  await showAppVersion();
  const cfg = getEffectiveSettings();
  const gridCols = cfg.gridColumns || 2;
  const maxActive = cfg.maxActiveConnections || 8;
  setMaxActiveConnections(maxActive);
  applyGridColumns(playersGrid, gridCols);
  initPlayers(playersGrid, cfg.cameras || []);

  if (isElectronEnv()) {
    if (window.electronAPI.setWindowSize) {
      const w = cfg.windowWidth ?? 1020;
      const h = cfg.windowHeight ?? 820;
      if (Number.isFinite(w) && Number.isFinite(h)) {
        window.electronAPI.setWindowSize(
          Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, w)),
          Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, h))
        );
      }
    }
    if (window.electronAPI.registerScreenshotShortcut) {
      window.electronAPI.registerScreenshotShortcut(cfg.screenshotShortcut || null);
    }
    applyMemoryWatchConfig(cfg);
    window.addEventListener("screenshot-trigger", () => batchScreenshot());
  }
});
