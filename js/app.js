import { loadSettings, saveSettings, getEffectiveSettings } from "./config.js";
import { initPlayers, getPlayerInstances, applyGridColumns } from "./layout.js";
import { setMaxActiveConnections } from "./webrtc-pool.js";
import { dataUrlToBase64 } from "./utils.js";

const SCREENSHOT_INTERVAL_MS = 200;
const DESKTOP_SAVE_DIR_KEY = "desktop_screenshot_dir";
const TOAST_DURATION_MS = 2500;

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
const saveDirDisplay = document.getElementById("saveDirDisplay");

const settingsOverlay = document.getElementById("settingsOverlay");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");
const settingsSaveBtn = document.getElementById("settingsSaveBtn");
  const settingWebrtcBase = document.getElementById("settingWebrtcBase");
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

const WINDOW_WIDTH_MIN = 520;
const WINDOW_WIDTH_MAX = 3840;
const WINDOW_HEIGHT_MIN = 420;
const WINDOW_HEIGHT_MAX = 2160;

function renderCameraRow(name = "", path = "", index = 0) {
  if (!settingCamerasList) return;
  const row = document.createElement("div");
  row.className = "camera-row";
  row.dataset.index = String(index);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "名称";
  nameInput.value = name;

  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.placeholder = "流路径，如 cam1";
  pathInput.value = path;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn-remove";
  removeBtn.textContent = "删除";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(pathInput);
  row.appendChild(removeBtn);
  settingCamerasList.appendChild(row);
}

function openSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.remove("hidden");
  settingsOverlay.setAttribute("aria-hidden", "false");

  const cfg = getEffectiveSettings();
  const webrtcBase = cfg.webrtcBase || "http://localhost:8889";
  const gridColumns = cfg.gridColumns || 2;
  const maxActive = cfg.maxActiveConnections || 8;
  const cameras = cfg.cameras && cfg.cameras.length ? cfg.cameras : [{ name: "摄像头1", path: "cam1" }];

  if (settingWebrtcBase) settingWebrtcBase.value = webrtcBase;
  if (settingGridColumns) settingGridColumns.value = String(gridColumns);
  if (settingMaxActive) settingMaxActive.value = String(maxActive);

  if (settingCamerasList) {
    settingCamerasList.innerHTML = "";
    cameras.forEach((c, i) => renderCameraRow(c.name, c.path, i));
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

  if (settingWindowSizeSection) {
    settingWindowSizeSection.style.display = isElectronEnv() ? "" : "none";
  }

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

function saveSettingsFromForm() {
  const cameras = [];
  settingCamerasList?.querySelectorAll(".camera-row").forEach((row) => {
    const inputs = row.querySelectorAll("input");
    const name = (inputs[0]?.value || "").trim();
    const path = (inputs[1]?.value || "").trim();
    if (path) cameras.push({ name: name || "未命名", path });
  });
  if (!cameras.length) cameras.push({ name: "摄像头1", path: "cam1" });

  const current = loadSettings();
  const webrtcBase = (settingWebrtcBase?.value || "").trim() || "http://localhost:8889";
  const gridColumns = Math.max(1, Math.min(4, parseInt(settingGridColumns?.value || "2", 10) || 2));
  const maxActive = Math.max(1, Math.min(64, parseInt(settingMaxActive?.value || "8", 10) || 8));
  const windowWidth = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingWindowWidth?.value || "1020", 10) || 1020));
  const windowHeight = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingWindowHeight?.value || "820", 10) || 820));
  const fullscreenWidth = Math.max(WINDOW_WIDTH_MIN, Math.min(WINDOW_WIDTH_MAX, parseInt(settingFullscreenWidth?.value || "1240", 10) || 1240));
  const fullscreenHeight = Math.max(WINDOW_HEIGHT_MIN, Math.min(WINDOW_HEIGHT_MAX, parseInt(settingFullscreenHeight?.value || "800", 10) || 800));
  const screenshotShortcut = (settingScreenshotShortcut?.value || "").trim();

  const next = { ...current, webrtcBase, cameras, gridColumns, maxActiveConnections: maxActive, windowWidth, windowHeight, fullscreenWidth, fullscreenHeight, screenshotShortcut: screenshotShortcut || undefined };
  saveSettings(next);

  if (isElectronEnv()) {
    if (window.electronAPI.setWindowSize) window.electronAPI.setWindowSize(windowWidth, windowHeight);
    if (window.electronAPI.registerScreenshotShortcut) window.electronAPI.registerScreenshotShortcut(screenshotShortcut || null);
  }

  setMaxActiveConnections(maxActive);
  applyGridColumns(playersGrid, gridColumns);
  initPlayers(playersGrid, next.cameras);
  closeSettings();
}

async function batchScreenshot() {
  const players = getPlayerInstances();
  if (!players.length) return;
  const ts = Date.now();

  if (isElectronEnv()) {
    let baseDir = localStorage.getItem(DESKTOP_SAVE_DIR_KEY);
    if (!baseDir) {
      baseDir = await window.electronAPI.chooseSaveDir();
      if (baseDir) localStorage.setItem(DESKTOP_SAVE_DIR_KEY, baseDir);
    }
    if (!baseDir) return;
    let success = 0;
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
            if (res?.ok) success += 1;
          }
          await new Promise((r) => setTimeout(r, SCREENSHOT_INTERVAL_MS));
        } catch (e) {
          console.error("batch screenshot error", e);
        }
      }
    }
    if (success > 0) {
      showToast(`已保存 ${success} 张截图到所选目录`);
      updateSaveDirDisplay();
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
        "浏览器环境下截图保存到下载目录，文件名中包含日期/时间/摄像头名称与统一时间戳。";
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
  return !!window.electronAPI;
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

  updateSaveDirDisplay();
}

window.addEventListener("load", () => {
  setupGlobalControls();
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
    window.addEventListener("screenshot-trigger", () => batchScreenshot());
  }
});
