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

  ensureGo2rtc: async () => {
    try {
      const base = await safeInvoke("ensure_go2rtc");
      return { success: true, data: base };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  getGo2rtcBase: () => safeInvoke("get_go2rtc_base"),

  registerStream: async (rtspUrl, name = "", transport = "") => {
    try {
      const data = await safeInvoke("register_stream", {
        name: name || "",
        rtspUrl,
        transport: transport || "",
      });
      return { success: true, data };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  unregisterStream: async (name) => {
    try {
      await safeInvoke("unregister_stream", { name });
      return { success: true };
    } catch (e) {
      return { success: false, message: e?.message || String(e) };
    }
  },

  openExternalUrl: async (url) => {
    try {
      await safeInvoke("open_external_url", { url });
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
  getScreenSize: () => safeInvoke("get_screen_size"),
  setWindowPosition: (x, y) => safeInvoke("set_window_position", { x, y }),
  isWindowMaximized: () => safeInvoke("is_window_maximized"),
  isWindowFullscreen: () => safeInvoke("is_window_fullscreen"),
  maximizeWindow: () => safeInvoke("maximize_window"),
  setWindowFullscreen: (fullscreen) => safeInvoke("set_window_fullscreen", { fullscreen: !!fullscreen }),
  unmaximizeWindow: () => safeInvoke("unmaximize_window"),
  restoreWindowGeometry: (opts) =>
    safeInvoke("restore_window_geometry", {
      width: opts.width,
      height: opts.height,
      x: opts.x ?? null,
      y: opts.y ?? null,
    }),
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

export function installDesktopGlobals() {
  const api = {
    ensureGo2rtc: desktopAPI.ensureGo2rtc,
    getGo2rtcBase: desktopAPI.getGo2rtcBase,
    registerStream: desktopAPI.registerStream,
    unregisterStream: desktopAPI.unregisterStream,
    openExternalUrl: desktopAPI.openExternalUrl,
    getAppVersion: desktopAPI.getAppVersion,
    chooseSaveDir: desktopAPI.chooseSaveDir,
    saveScreenshot: desktopAPI.saveScreenshot,
    setWindowSize: desktopAPI.setWindowSize,
    getWindowSize: desktopAPI.getWindowSize,
    getScreenSize: desktopAPI.getScreenSize,
    setWindowPosition: desktopAPI.setWindowPosition,
    isWindowMaximized: desktopAPI.isWindowMaximized,
    isWindowFullscreen: desktopAPI.isWindowFullscreen,
    maximizeWindow: desktopAPI.maximizeWindow,
    setWindowFullscreen: desktopAPI.setWindowFullscreen,
    unmaximizeWindow: desktopAPI.unmaximizeWindow,
    restoreWindowGeometry: desktopAPI.restoreWindowGeometry,
    registerScreenshotShortcut: desktopAPI.registerScreenshotShortcut,
    configureMemoryWatch: desktopAPI.configureMemoryWatch,
    get platform() {
      return navigator.platform?.toLowerCase().includes("win")
        ? "win32"
        : navigator.platform?.toLowerCase().includes("mac")
          ? "darwin"
          : "linux";
    },
  };
  if (typeof window !== "undefined") {
    window.desktopAPI = desktopAPI;
    window.electronAPI = api;
  }
  return desktopAPI.initListeners();
}
