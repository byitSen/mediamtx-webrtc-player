import { loadSettings, saveSettings, getEffectiveSettings } from "./config.js";
import { initPlayers, getPlayerInstances, applyGridColumns } from "./layout.js";
import { setMaxActiveConnections } from "./webrtc-pool.js";
import { dataUrlToBase64 } from "./utils.js";

const SCREENSHOT_INTERVAL_MS = 200;
const TAURI_SAVE_DIR_KEY = "tauri_screenshot_dir";
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
  const gridColumns = cfg.gridColumns || 3;
  const maxActive = cfg.maxActiveConnections || 8;
  const cameras = cfg.cameras && cfg.cameras.length ? cfg.cameras : [{ name: "摄像头1", path: "cam1" }];

  if (settingWebrtcBase) settingWebrtcBase.value = webrtcBase;
  if (settingGridColumns) settingGridColumns.value = String(gridColumns);
  if (settingMaxActive) settingMaxActive.value = String(maxActive);

  if (settingCamerasList) {
    settingCamerasList.innerHTML = "";
    cameras.forEach((c, i) => renderCameraRow(c.name, c.path, i));
  }
  updateSaveDirDisplay();
}

function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.classList.add("hidden");
  settingsOverlay.setAttribute("aria-hidden", "true");
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
  const gridColumns = Math.max(1, Math.min(4, parseInt(settingGridColumns?.value || "3", 10) || 3));
  const maxActive = Math.max(1, Math.min(64, parseInt(settingMaxActive?.value || "8", 10) || 8));

  const next = { ...current, webrtcBase, cameras, gridColumns, maxActiveConnections: maxActive };
  saveSettings(next);

  setMaxActiveConnections(maxActive);
  applyGridColumns(playersGrid, gridColumns);
  initPlayers(playersGrid, next.cameras);
  closeSettings();
}

async function batchScreenshot() {
  const players = getPlayerInstances();
  if (!players.length) return;
  const ts = Date.now();
  const isTauri = isTauriEnv();

  if (isTauri) {
    const invoke =
      window.__TAURI__?.core?.invoke ?? (await import("@tauri-apps/api/core")).invoke;
    const dialog =
      window.__TAURI__?.dialog ?? await import("@tauri-apps/plugin-dialog");
    let baseDir = localStorage.getItem(TAURI_SAVE_DIR_KEY);
    if (!baseDir) {
      baseDir = await dialog.open({ directory: true, multiple: false });
      if (baseDir) localStorage.setItem(TAURI_SAVE_DIR_KEY, baseDir);
    }
    if (!baseDir) return;
    let success = 0;
    for (const p of players) {
      if (p.isConnected) {
        try {
          const result = await p.singleScreenshot(ts);
          if (result?.relativePath && result?.dataUrl) {
            const base64Png = dataUrlToBase64(result.dataUrl);
            await invoke("save_screenshot", {
              baseDir,
              relativePath: result.relativePath,
              base64Png,
            });
            success += 1;
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
    console.log(`已为 ${success} 路摄像头完成截图，统一时间戳: ${ts}`);
  }
}

function updateSaveDirDisplay() {
  const isTauri = isTauriEnv();
  const dir = isTauri ? localStorage.getItem(TAURI_SAVE_DIR_KEY) : null;
  if (saveDirDisplay) {
    if (isTauri) {
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
    settingSaveDirPath.textContent = isTauri ? (dir || "未设置") : "仅桌面版可用";
    settingSaveDirPath.style.cursor = isTauri ? "pointer" : "";
    settingSaveDirPath.title = isTauri ? "点击选择目录" : "";
  }
  if (chooseSaveDirBtn) {
    chooseSaveDirBtn.disabled = !isTauri;
    chooseSaveDirBtn.title = isTauri ? "打开目录选择" : "仅桌面版可用";
  }
}

function isTauriEnv() {
  if (typeof window === "undefined") return false;
  return !!(window.__TAURI__ || window.isTauri);
}

async function chooseSaveDir() {
  if (!isTauriEnv()) return;
  try {
    const openDialog =
      window.__TAURI__?.dialog?.open ||
      (await import("@tauri-apps/plugin-dialog")).open;
    const baseDir = await openDialog({ directory: true, multiple: false });
    if (baseDir) {
      localStorage.setItem(TAURI_SAVE_DIR_KEY, baseDir);
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
      if (isTauriEnv()) chooseSaveDir();
    });
  }

  updateSaveDirDisplay();
}

window.addEventListener("load", () => {
  setupGlobalControls();
  const cfg = getEffectiveSettings();
  const gridCols = cfg.gridColumns || 3;
  const maxActive = cfg.maxActiveConnections || 8;
  setMaxActiveConnections(maxActive);
  applyGridColumns(playersGrid, gridCols);
  initPlayers(playersGrid, cfg.cameras || []);
});
