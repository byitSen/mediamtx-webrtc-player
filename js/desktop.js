/**
 * 桌面 API 封装（Tauri）。浏览器环境返回受限 stub。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function isTauri() {
  return typeof window !== "undefined" && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

export function isDesktopEnv() {
  return isTauri();
}

async function safeInvoke(cmd, args) {
  if (!isTauri()) throw new Error("仅桌面版可用");
  return invoke(cmd, args);
}

export const desktopAPI = {
  isDesktop: isDesktopEnv,

  createRtspProxy: async (rtspUrl) => {
    try {
      const wsUrl = await safeInvoke("start_rtsp_proxy", { rtspUrl });
      return { success: true, data: wsUrl };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  destroyRtspProxy: async (rtspUrl) => {
    try {
      await safeInvoke("stop_rtsp_proxy", { rtspUrl });
      return { success: true };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  destroyAllRtspProxies: async () => {
    try {
      await safeInvoke("stop_all_rtsp_proxies");
      return { success: true };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  getAppVersion: () => safeInvoke("get_app_version"),
  getPlatform: () => safeInvoke("get_platform"),
  chooseSaveDir: () => safeInvoke("choose_save_dir"),
  saveScreenshot: async (opts) => {
    try {
      await safeInvoke("save_screenshot", {
        baseDir: opts.baseDir,
        relativePath: opts.relativePath,
        base64Png: opts.base64Png,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e?.message || String(e) };
    }
  },
  setWindowSize: (width, height) => safeInvoke("set_window_size", { width, height }),
  getWindowSize: () => safeInvoke("get_window_size"),
  registerScreenshotShortcut: (accelerator) =>
    safeInvoke("register_screenshot_shortcut", { accelerator: accelerator || null }),
  configureMemoryWatch: async (cfg) => {
    try {
      return await safeInvoke("configure_memory_watch", {
        config: {
          enabled: !!cfg.enabled,
          processName: (cfg.processName || "").trim() || "weight.exe",
          moduleOffset: (cfg.moduleOffset || "").trim() || "0x9B8568",
          offsets: Array.isArray(cfg.offsets) ? cfg.offsets.map((o) => String(o)) : [],
          pointerSize: cfg.pointerSize ?? 4,
          triggerValue: cfg.triggerValue ?? 0,
        },
      });
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  },

  async initListeners() {
    if (!isTauri()) return;
    await listen("screenshot-trigger", () => {
      window.dispatchEvent(new CustomEvent("screenshot-trigger"));
    });
    await listen("memory-watch-log", (ev) => {
      window.dispatchEvent(new CustomEvent("memory-watch-log", { detail: ev.payload }));
    });
  },
};

// 兼容旧代码：挂到 window.electronAPI 同名能力
export function installDesktopGlobals() {
  const api = {
    createRtspProxy: desktopAPI.createRtspProxy,
    destroyRtspProxy: desktopAPI.destroyRtspProxy,
    destroyAllRtspProxies: desktopAPI.destroyAllRtspProxies,
    getAppVersion: desktopAPI.getAppVersion,
    chooseSaveDir: desktopAPI.chooseSaveDir,
    saveScreenshot: desktopAPI.saveScreenshot,
    setWindowSize: desktopAPI.setWindowSize,
    getWindowSize: desktopAPI.getWindowSize,
    registerScreenshotShortcut: desktopAPI.registerScreenshotShortcut,
    configureMemoryWatch: desktopAPI.configureMemoryWatch,
    get platform() {
      // sync fallback; prefer async getPlatform where possible
      return navigator.platform?.toLowerCase().includes("win") ? "win32" : navigator.platform?.toLowerCase().includes("mac") ? "darwin" : "linux";
    },
  };
  if (typeof window !== "undefined") {
    window.desktopAPI = desktopAPI;
    window.electronAPI = api;
  }
  return desktopAPI.initListeners();
}
