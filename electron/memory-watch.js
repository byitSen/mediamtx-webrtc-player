/**
 * Windows 进程内存监视：按 64 位指针链轮询，最终 int32 边沿变为 0 时触发回调。
 * 非 win32 平台为空操作。
 *
 * 指针链（Cheat Engine）：
 *   p = *(moduleBase + moduleOffset)
 *   p = *(p + offsets[0])
 *   ...
 *   value = int32(p + offsets[last])
 */
const POLL_INTERVAL_MS = 100;
const STATUS_LOG_INTERVAL_MS = 1000;

const TH32CS_SNAPPROCESS = 0x00000002;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const LIST_MODULES_ALL = 0x03;
const MAX_PATH = 260;

let timer = null;
let armed = true;
let onTrigger = null;
let onLog = null;
let currentConfig = null;
let winApi = null;
let winApiError = null;
let lastStatusKey = "";
let lastStatusLogAt = 0;

function hexAddr(n) {
  if (n == null) return "null";
  const b = typeof n === "bigint" ? n : BigInt(n);
  return "0x" + b.toString(16).toUpperCase();
}

function hexOff(n) {
  return "0x" + (Number(n) >>> 0).toString(16).toUpperCase();
}

function emitLog(level, message, detail) {
  if (typeof onLog !== "function") return;
  try {
    onLog({
      ts: Date.now(),
      level: level || "info",
      message: String(message || ""),
      detail: detail || null,
    });
  } catch (_) {}
}

/** 状态类日志：相同状态节流；状态变化立即输出 */
function emitStatus(level, key, message, detail) {
  const now = Date.now();
  if (key === lastStatusKey && now - lastStatusLogAt < STATUS_LOG_INTERVAL_MS) return;
  lastStatusKey = key;
  lastStatusLogAt = now;
  emitLog(level, message, detail);
}

function parseOffset(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v) >>> 0;
  if (typeof v === "bigint") return Number(v & 0xffffffffn);
  if (typeof v !== "string") return 0;
  const s = v.trim();
  if (!s) return 0;
  const n = s.toLowerCase().startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const processName = String(cfg.processName || "").trim();
  const moduleOffset = parseOffset(cfg.moduleOffset);
  const rawOffsets = Array.isArray(cfg.offsets) ? cfg.offsets : [];
  const offsets = rawOffsets.map(parseOffset);
  return {
    enabled: !!cfg.enabled,
    processName,
    moduleOffset,
    offsets,
  };
}

function loadWinApi() {
  if (winApi) return winApi;
  if (winApiError) return null;
  if (process.platform !== "win32") {
    winApiError = new Error("not win32");
    return null;
  }
  try {
    const koffi = require("koffi");

    const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
      dwSize: "uint32",
      cntUsage: "uint32",
      th32ProcessID: "uint32",
      th32DefaultHeapID: "uintptr",
      th32ModuleID: "uint32",
      cntThreads: "uint32",
      th32ParentProcessID: "uint32",
      pcPriClassBase: "int32",
      dwFlags: "uint32",
      szExeFile: koffi.array("char16", MAX_PATH),
    });

    const MODULEINFO = koffi.struct("MODULEINFO", {
      lpBaseOfDll: "void *",
      SizeOfImage: "uint32",
      EntryPoint: "void *",
    });

    const kernel32 = koffi.load("kernel32.dll");
    const psapi = koffi.load("psapi.dll");

    winApi = {
      koffi,
      PROCESSENTRY32W,
      MODULEINFO,
      entrySize: koffi.sizeof(PROCESSENTRY32W),
      moduleInfoSize: koffi.sizeof(MODULEINFO),
      CreateToolhelp32Snapshot: kernel32.func("CreateToolhelp32Snapshot", "void *", ["uint32", "uint32"]),
      Process32FirstW: kernel32.func("Process32FirstW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      Process32NextW: kernel32.func("Process32NextW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      OpenProcess: kernel32.func("OpenProcess", "void *", ["uint32", "bool", "uint32"]),
      CloseHandle: kernel32.func("CloseHandle", "bool", ["void *"]),
      ReadProcessMemory: kernel32.func("ReadProcessMemory", "bool", [
        "void *",
        "void *",
        "void *",
        "size_t",
        koffi.out("size_t *"),
      ]),
      EnumProcessModulesEx: psapi.func("EnumProcessModulesEx", "bool", [
        "void *",
        "void *",
        "uint32",
        koffi.out("uint32 *"),
        "uint32",
      ]),
      GetModuleInformation: psapi.func("GetModuleInformation", "bool", [
        "void *",
        "void *",
        koffi.out(koffi.pointer(MODULEINFO)),
        "uint32",
      ]),
      isNullHandle(h) {
        if (h == null || h === 0 || h === 0n) return true;
        try {
          const n = typeof h === "bigint" ? h : BigInt(koffi.address(h));
          return n === 0n || n === 0xffffffffffffffffn;
        } catch {
          return true;
        }
      },
      handleAddress(h) {
        return typeof h === "bigint" ? h : BigInt(koffi.address(h));
      },
    };
    return winApi;
  } catch (e) {
    winApiError = e;
    console.warn("[memory-watch] failed to load Win32 API:", e.message);
    return null;
  }
}

function findPidByName(api, processName) {
  const target = processName.toLowerCase();
  const snap = api.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (api.isNullHandle(snap)) return { ok: false, error: "CreateToolhelp32Snapshot failed" };

  try {
    const entry = {
      dwSize: api.entrySize,
      cntUsage: 0,
      th32ProcessID: 0,
      th32DefaultHeapID: 0,
      th32ModuleID: 0,
      cntThreads: 0,
      th32ParentProcessID: 0,
      pcPriClassBase: 0,
      dwFlags: 0,
      szExeFile: "",
    };

    if (!api.Process32FirstW(snap, entry)) return { ok: false, error: "Process32FirstW failed" };
    do {
      const name = String(entry.szExeFile || "").toLowerCase();
      if (name === target) return { ok: true, pid: entry.th32ProcessID >>> 0 };
      entry.dwSize = api.entrySize;
    } while (api.Process32NextW(snap, entry));
    return { ok: false, error: `process not found: ${processName}` };
  } finally {
    api.CloseHandle(snap);
  }
}

function getMainModuleBase(api, hProcess) {
  const cb = 8;
  const buf = Buffer.alloc(cb);
  const needed = [0];
  if (!api.EnumProcessModulesEx(hProcess, buf, cb, needed, LIST_MODULES_ALL)) {
    return { ok: false, error: "EnumProcessModulesEx failed (可能权限不足)" };
  }
  if ((needed[0] | 0) < 8) return { ok: false, error: "no modules returned" };
  const hModule = buf.readBigUInt64LE(0);
  if (hModule === 0n) return { ok: false, error: "null HMODULE" };

  const info = { lpBaseOfDll: null, SizeOfImage: 0, EntryPoint: null };
  const modPtr = api.koffi.as(hModule, "void *");
  if (!api.GetModuleInformation(hProcess, modPtr, info, api.moduleInfoSize)) {
    return { ok: false, error: "GetModuleInformation failed" };
  }
  if (!info.lpBaseOfDll) return { ok: false, error: "lpBaseOfDll null" };
  return { ok: true, base: api.handleAddress(info.lpBaseOfDll) };
}

function readBytes(api, hProcess, address, size) {
  if (address == null || address === 0n) return null;
  const buf = Buffer.alloc(size);
  const read = [0n];
  const addrPtr = api.koffi.as(address, "void *");
  const ok = api.ReadProcessMemory(hProcess, addrPtr, buf, size, read);
  if (!ok) return null;
  const n = typeof read[0] === "bigint" ? Number(read[0]) : Number(read[0]) || 0;
  if (n < size) return null;
  return buf;
}

function readU64(api, hProcess, address) {
  const buf = readBytes(api, hProcess, address, 8);
  if (!buf) return null;
  return buf.readBigUInt64LE(0);
}

function readI32(api, hProcess, address) {
  const buf = readBytes(api, hProcess, address, 4);
  if (!buf) return null;
  return buf.readInt32LE(0);
}

function resolveChainValue(api, hProcess, moduleBase, moduleOffset, offsets) {
  if (!offsets.length) return { ok: false, error: "empty offsets" };

  const staticAddr = moduleBase + BigInt(moduleOffset >>> 0);
  let ptr = readU64(api, hProcess, staticAddr);
  if (ptr == null || ptr === 0n) {
    return {
      ok: false,
      error: `read static base failed @ ${hexAddr(staticAddr)} (module+${hexOff(moduleOffset)})`,
      step: 0,
      staticAddr,
    };
  }

  const steps = [{ addr: staticAddr, ptr }];
  for (let i = 0; i < offsets.length - 1; i++) {
    const addr = ptr + BigInt(offsets[i] >>> 0);
    const next = readU64(api, hProcess, addr);
    if (next == null || next === 0n) {
      return {
        ok: false,
        error: `pointer chain break at offset[${i}]=${hexOff(offsets[i])} @ ${hexAddr(addr)}`,
        step: i + 1,
        steps,
        failAddr: addr,
      };
    }
    ptr = next;
    steps.push({ addr, ptr });
  }

  const lastOff = offsets[offsets.length - 1] >>> 0;
  const finalAddr = ptr + BigInt(lastOff);
  const value = readI32(api, hProcess, finalAddr);
  if (value == null) {
    return {
      ok: false,
      error: `read int32 failed @ ${hexAddr(finalAddr)} (last+${hexOff(lastOff)})`,
      step: offsets.length,
      steps,
      finalAddr,
    };
  }
  return { ok: true, value, finalAddr, moduleBase, staticAddr, steps };
}

function pollOnce() {
  if (!currentConfig?.enabled || !currentConfig.processName) return;
  const api = loadWinApi();
  if (!api) {
    emitStatus("error", "no_api", "Win32 API 不可用", { err: winApiError?.message });
    return;
  }

  const found = findPidByName(api, currentConfig.processName);
  if (!found.ok) {
    emitStatus("warn", `noproc:${currentConfig.processName}`, `未找到进程 ${currentConfig.processName}`, found);
    return;
  }

  const hProcess = api.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, found.pid);
  if (api.isNullHandle(hProcess)) {
    emitStatus("error", `open:${found.pid}`, `OpenProcess 失败 pid=${found.pid}（可能需要管理员权限）`, {
      pid: found.pid,
    });
    return;
  }

  try {
    const mod = getMainModuleBase(api, hProcess);
    if (!mod.ok) {
      emitStatus("error", `mod:${found.pid}`, `获取模块基址失败: ${mod.error}`, { pid: found.pid });
      return;
    }

    const result = resolveChainValue(
      api,
      hProcess,
      mod.base,
      currentConfig.moduleOffset,
      currentConfig.offsets
    );
    if (!result.ok) {
      emitStatus("warn", `chain:${result.error}`, `指针链读取失败: ${result.error}`, {
        pid: found.pid,
        moduleBase: hexAddr(mod.base),
        step: result.step,
      });
      return;
    }

    const value = result.value;
    emitStatus(
      "ok",
      `ok:${found.pid}:${value}:${armed ? 1 : 0}`,
      `监听成功 value=${value} armed=${armed ? "yes" : "no"} final=${hexAddr(result.finalAddr)}`,
      {
        pid: found.pid,
        processName: currentConfig.processName,
        moduleBase: hexAddr(mod.base),
        staticAddr: hexAddr(result.staticAddr),
        finalAddr: hexAddr(result.finalAddr),
        value,
        armed,
      }
    );

    if (value === 0) {
      if (armed) {
        armed = false;
        emitLog("trigger", `触发截图：value 变为 0 @ ${hexAddr(result.finalAddr)}`, {
          pid: found.pid,
          finalAddr: hexAddr(result.finalAddr),
          value,
        });
        if (typeof onTrigger === "function") {
          try {
            onTrigger();
          } catch (e) {
            emitLog("error", `onTrigger 异常: ${e.message}`);
            console.error("[memory-watch] onTrigger error", e);
          }
        }
      }
    } else {
      armed = true;
    }
  } finally {
    api.CloseHandle(hProcess);
  }
}

function stopMemoryWatch() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (currentConfig) {
    emitLog("info", "内存监控已停止");
  }
  currentConfig = null;
  armed = true;
  lastStatusKey = "";
  lastStatusLogAt = 0;
}

function startMemoryWatch(config, triggerCb, logCb) {
  stopMemoryWatch();
  if (logCb) onLog = logCb;
  const normalized = normalizeConfig(config);
  onTrigger = triggerCb || null;
  if (!normalized?.enabled || !normalized.processName || !normalized.offsets.length) {
    emitLog("info", "监控未启动：未启用或配置不完整", normalized);
    return { ok: false, reason: "disabled_or_incomplete" };
  }
  if (process.platform !== "win32") {
    emitLog("warn", "监控未启动：非 Windows 平台");
    return { ok: false, reason: "not_win32" };
  }
  if (!loadWinApi()) {
    emitLog("error", `监控未启动：Win32 API 加载失败: ${winApiError?.message || "unknown"}`);
    return { ok: false, reason: "api_unavailable" };
  }
  currentConfig = normalized;
  armed = true;
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  emitLog("info", `内存监控已启动 process=${normalized.processName} static=${hexOff(normalized.moduleOffset)} offsets=[${normalized.offsets.map(hexOff).join(", ")}]`, {
    processName: normalized.processName,
    moduleOffset: hexOff(normalized.moduleOffset),
    offsets: normalized.offsets.map(hexOff),
  });
  return { ok: true };
}

function updateMemoryWatch(config, triggerCb, logCb) {
  if (triggerCb) onTrigger = triggerCb;
  if (logCb) onLog = logCb;
  const normalized = normalizeConfig(config);
  if (!normalized?.enabled || !normalized.processName || !normalized.offsets.length) {
    stopMemoryWatch();
    emitLog("info", "监控未启动：未启用或配置不完整", normalized);
    return { ok: false, reason: "disabled_or_incomplete" };
  }
  if (process.platform !== "win32") {
    stopMemoryWatch();
    emitLog("warn", "监控未启动：非 Windows 平台");
    return { ok: false, reason: "not_win32" };
  }
  if (!loadWinApi()) {
    stopMemoryWatch();
    emitLog("error", `监控未启动：Win32 API 加载失败: ${winApiError?.message || "unknown"}`);
    return { ok: false, reason: "api_unavailable" };
  }
  const wasRunning = !!timer;
  currentConfig = normalized;
  if (!timer) {
    armed = true;
    timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }
  lastStatusKey = "";
  emitLog(
    "info",
    `${wasRunning ? "监控配置已更新" : "内存监控已启动"} process=${normalized.processName} static=${hexOff(normalized.moduleOffset)} offsets=[${normalized.offsets.map(hexOff).join(", ")}]`,
    {
      processName: normalized.processName,
      moduleOffset: hexOff(normalized.moduleOffset),
      offsets: normalized.offsets.map(hexOff),
    }
  );
  return { ok: true };
}

function setMemoryWatchLogger(logCb) {
  onLog = typeof logCb === "function" ? logCb : null;
}

module.exports = {
  startMemoryWatch,
  stopMemoryWatch,
  updateMemoryWatch,
  setMemoryWatchLogger,
  parseOffset,
};
