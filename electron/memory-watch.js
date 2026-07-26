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

const TH32CS_SNAPPROCESS = 0x00000002;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const LIST_MODULES_ALL = 0x03;
const MAX_PATH = 260;

let timer = null;
let armed = true;
let onTrigger = null;
let currentConfig = null;
let winApi = null;
let winApiError = null;

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
  if (api.isNullHandle(snap)) return null;

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

    if (!api.Process32FirstW(snap, entry)) return null;
    do {
      const name = String(entry.szExeFile || "").toLowerCase();
      if (name === target) return entry.th32ProcessID >>> 0;
      entry.dwSize = api.entrySize;
    } while (api.Process32NextW(snap, entry));
    return null;
  } finally {
    api.CloseHandle(snap);
  }
}

function getMainModuleBase(api, hProcess) {
  const cb = 8;
  const buf = Buffer.alloc(cb);
  const needed = [0];
  if (!api.EnumProcessModulesEx(hProcess, buf, cb, needed, LIST_MODULES_ALL)) return null;
  if ((needed[0] | 0) < 8) return null;
  const hModule = buf.readBigUInt64LE(0);
  if (hModule === 0n) return null;

  const info = { lpBaseOfDll: null, SizeOfImage: 0, EntryPoint: null };
  const modPtr = api.koffi.as(hModule, "void *");
  if (!api.GetModuleInformation(hProcess, modPtr, info, api.moduleInfoSize)) return null;
  if (!info.lpBaseOfDll) return null;
  return api.handleAddress(info.lpBaseOfDll);
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
  if (!offsets.length) return null;

  let ptr = readU64(api, hProcess, moduleBase + BigInt(moduleOffset >>> 0));
  if (ptr == null || ptr === 0n) return null;

  for (let i = 0; i < offsets.length - 1; i++) {
    ptr = readU64(api, hProcess, ptr + BigInt(offsets[i] >>> 0));
    if (ptr == null || ptr === 0n) return null;
  }

  const lastOff = offsets[offsets.length - 1] >>> 0;
  return readI32(api, hProcess, ptr + BigInt(lastOff));
}

function pollOnce() {
  if (!currentConfig?.enabled || !currentConfig.processName) return;
  const api = loadWinApi();
  if (!api) return;

  const pid = findPidByName(api, currentConfig.processName);
  if (!pid) return;

  const hProcess = api.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
  if (api.isNullHandle(hProcess)) return;

  try {
    const moduleBase = getMainModuleBase(api, hProcess);
    if (moduleBase == null) return;

    const value = resolveChainValue(
      api,
      hProcess,
      moduleBase,
      currentConfig.moduleOffset,
      currentConfig.offsets
    );
    if (value == null) return;

    if (value === 0) {
      if (armed) {
        armed = false;
        if (typeof onTrigger === "function") {
          try {
            onTrigger();
          } catch (e) {
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
  currentConfig = null;
  armed = true;
}

function startMemoryWatch(config, triggerCb) {
  stopMemoryWatch();
  const normalized = normalizeConfig(config);
  onTrigger = triggerCb || null;
  if (!normalized?.enabled || !normalized.processName || !normalized.offsets.length) {
    return { ok: false, reason: "disabled_or_incomplete" };
  }
  if (process.platform !== "win32") {
    return { ok: false, reason: "not_win32" };
  }
  if (!loadWinApi()) {
    return { ok: false, reason: "api_unavailable" };
  }
  currentConfig = normalized;
  armed = true;
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  return { ok: true };
}

function updateMemoryWatch(config, triggerCb) {
  if (triggerCb) onTrigger = triggerCb;
  const normalized = normalizeConfig(config);
  if (!normalized?.enabled || !normalized.processName || !normalized.offsets.length) {
    stopMemoryWatch();
    return { ok: false, reason: "disabled_or_incomplete" };
  }
  if (process.platform !== "win32") {
    stopMemoryWatch();
    return { ok: false, reason: "not_win32" };
  }
  if (!loadWinApi()) {
    stopMemoryWatch();
    return { ok: false, reason: "api_unavailable" };
  }
  currentConfig = normalized;
  if (!timer) {
    armed = true;
    timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }
  return { ok: true };
}

module.exports = {
  startMemoryWatch,
  stopMemoryWatch,
  updateMemoryWatch,
  parseOffset,
};
