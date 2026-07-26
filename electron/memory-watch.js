/**
 * Windows 进程内存监视：按指针链轮询，最终 int32 边沿变为 0 时触发回调。
 * 自动识别目标进程 32/64 位并选用对应指针宽度。
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
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const LIST_MODULES_32BIT = 0x01;
const LIST_MODULES_64BIT = 0x02;
const LIST_MODULES_ALL = 0x03;
const MAX_PATH = 260;
const MAX_MODULE_NAME32 = 255;

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
  try {
    const b = typeof n === "bigint" ? n : BigInt(n);
    return "0x" + b.toString(16).toUpperCase();
  } catch {
    return String(n);
  }
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
  // pointerSize: 8 | 4 | 0(auto)；默认 8（64 位）
  let pointerSize = Number(cfg.pointerSize);
  if (pointerSize !== 4 && pointerSize !== 8 && pointerSize !== 0) pointerSize = 8;
  return {
    enabled: !!cfg.enabled,
    processName,
    moduleOffset,
    offsets,
    pointerSize,
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

    // MODULEENTRY32W：用 uintptr 存 modBaseAddr，避免 void* 编解码问题
    const MODULEENTRY32W = koffi.struct("MODULEENTRY32W", {
      dwSize: "uint32",
      th32ModuleID: "uint32",
      th32ProcessID: "uint32",
      GlblcntUsage: "uint32",
      ProccntUsage: "uint32",
      modBaseAddr: "uintptr",
      modBaseSize: "uint32",
      hModule: "uintptr",
      szModule: koffi.array("char16", MAX_MODULE_NAME32 + 1),
      szExePath: koffi.array("char16", MAX_PATH),
    });

    const kernel32 = koffi.load("kernel32.dll");
    const psapi = koffi.load("psapi.dll");
    const advapi = koffi.load("advapi32.dll");

    const LUID = koffi.struct("LUID", {
      LowPart: "uint32",
      HighPart: "int32",
    });
    const LUID_AND_ATTRIBUTES = koffi.struct("LUID_AND_ATTRIBUTES", {
      Luid: LUID,
      Attributes: "uint32",
    });
    const TOKEN_PRIVILEGES = koffi.struct("TOKEN_PRIVILEGES", {
      PrivilegeCount: "uint32",
      Privileges: koffi.array(LUID_AND_ATTRIBUTES, 1),
    });

    winApi = {
      koffi,
      PROCESSENTRY32W,
      MODULEENTRY32W,
      LUID,
      TOKEN_PRIVILEGES,
      entrySize: koffi.sizeof(PROCESSENTRY32W),
      moduleEntrySize: koffi.sizeof(MODULEENTRY32W),
      CreateToolhelp32Snapshot: kernel32.func("CreateToolhelp32Snapshot", "void *", ["uint32", "uint32"]),
      Process32FirstW: kernel32.func("Process32FirstW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      Process32NextW: kernel32.func("Process32NextW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]),
      Module32FirstW: kernel32.func("Module32FirstW", "bool", ["void *", koffi.inout(koffi.pointer(MODULEENTRY32W))]),
      Module32NextW: kernel32.func("Module32NextW", "bool", ["void *", koffi.inout(koffi.pointer(MODULEENTRY32W))]),
      OpenProcess: kernel32.func("OpenProcess", "void *", ["uint32", "bool", "uint32"]),
      CloseHandle: kernel32.func("CloseHandle", "bool", ["void *"]),
      IsWow64Process: kernel32.func("IsWow64Process", "bool", ["void *", koffi.out("int *")]),
      GetLastError: kernel32.func("GetLastError", "uint32", []),
      SetLastError: kernel32.func("SetLastError", "void", ["uint32"]),
      GetCurrentProcess: kernel32.func("GetCurrentProcess", "void *", []),
      ReadProcessMemory: kernel32.func("ReadProcessMemory", "bool", [
        "void *",
        "uintptr",
        "void *",
        "uintptr",
        "void *",
      ]),
      EnumProcessModulesEx: psapi.func("EnumProcessModulesEx", "bool", [
        "void *",
        "void *",
        "uint32",
        koffi.out("uint32 *"),
        "uint32",
      ]),
      GetModuleBaseNameW: psapi.func("GetModuleBaseNameW", "uint32", ["void *", "uintptr", "void *", "uint32"]),
      OpenProcessToken: advapi.func("OpenProcessToken", "bool", ["void *", "uint32", koffi.out("void *")]),
      LookupPrivilegeValueW: advapi.func("LookupPrivilegeValueW", "bool", [
        "void *",
        "str16",
        koffi.out(koffi.pointer(LUID)),
      ]),
      AdjustTokenPrivileges: advapi.func("AdjustTokenPrivileges", "bool", [
        "void *",
        "bool",
        koffi.pointer(TOKEN_PRIVILEGES),
        "uint32",
        "void *",
        "void *",
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

/** 返回 4 或 8；Windows BOOL 用 int 读取 */
function detectPtrSize(api, hProcess) {
  const flag = [0];
  try {
    if (api.IsWow64Process(hProcess, flag)) {
      // Wow64=true → 目标是 32 位进程
      if (flag[0]) return 4;
      if (process.arch === "ia32") return 4;
      return 8;
    }
  } catch (_) {}
  return 8;
}

function resolvePtrSize(api, hProcess, configured) {
  if (configured === 4 || configured === 8) return configured;
  return detectPtrSize(api, hProcess);
}

function readModuleBaseName(api, hProcess, hModule) {
  const buf = Buffer.alloc((MAX_PATH + 1) * 2);
  const modAddr = typeof hModule === "bigint" ? Number(hModule) : Number(hModule);
  if (!modAddr) return "";
  const n = api.GetModuleBaseNameW(hProcess, modAddr, buf, MAX_PATH);
  if (!n) return "";
  return buf.toString("utf16le", 0, n * 2).replace(/\0+$/, "");
}

const TOKEN_ADJUST_PRIVILEGES = 0x0020;
const TOKEN_QUERY = 0x0008;
const SE_PRIVILEGE_ENABLED = 0x00000002;
let debugPrivTried = false;

function enableSeDebugPrivilege(api) {
  if (debugPrivTried) return;
  debugPrivTried = true;
  try {
    const tokenRef = [null];
    if (!api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, tokenRef)) {
      emitLog("warn", "OpenProcessToken 失败，可能无法读取受保护进程", { lastError: api.GetLastError() });
      return;
    }
    const hToken = tokenRef[0];
    const luid = { LowPart: 0, HighPart: 0 };
    if (!api.LookupPrivilegeValueW(null, "SeDebugPrivilege", luid)) {
      api.CloseHandle(hToken);
      emitLog("warn", "LookupPrivilegeValue(SeDebugPrivilege) 失败", { lastError: api.GetLastError() });
      return;
    }
    const tp = {
      PrivilegeCount: 1,
      Privileges: [{ Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
    };
    api.AdjustTokenPrivileges(hToken, false, tp, 0, null, null);
    const err = api.GetLastError() >>> 0;
    api.CloseHandle(hToken);
    if (err !== 0) {
      emitLog("warn", `AdjustTokenPrivileges 返回 lastError=${err}（可尝试以管理员运行）`, { lastError: err });
    } else {
      emitLog("info", "已启用 SeDebugPrivilege");
    }
  } catch (e) {
    emitLog("warn", `启用 SeDebugPrivilege 异常: ${e.message}`);
  }
}

function toAddrNumber(address) {
  if (address == null) return null;
  if (typeof address === "bigint") {
    if (address === 0n) return null;
    return Number(address);
  }
  const n = Number(address);
  return n ? n : null;
}

function readBytes(api, hProcess, address, size) {
  const addrNum = toAddrNumber(address);
  if (addrNum == null) return { ok: false, error: "null address", lastError: 0 };
  const buf = Buffer.alloc(size);
  const bytesRead = Buffer.alloc(8);
  try {
    api.SetLastError(0);
  } catch (_) {}
  let ok = false;
  try {
    ok = !!api.ReadProcessMemory(hProcess, addrNum, buf, size, bytesRead);
  } catch (e) {
    return { ok: false, error: `RPM throw: ${e.message}`, lastError: -1, address: hexAddr(address), size };
  }
  if (!ok) {
    let lastErr = 0;
    try {
      lastErr = api.GetLastError() >>> 0;
    } catch (_) {}
    return {
      ok: false,
      error: `RPM failed`,
      lastError: lastErr,
      address: hexAddr(address),
      size,
      hint: lastErr === 5 ? "拒绝访问，请尝试以管理员运行" : lastErr === 299 ? "部分复制，地址可能无效" : undefined,
    };
  }
  const nread = bytesRead.readUInt32LE(0); // size_t low dword enough for small reads
  if (nread > 0 && nread < size) {
    return { ok: false, error: `RPM partial ${nread}/${size}`, lastError: 299, address: hexAddr(address), size };
  }
  return { ok: true, buf };
}

/**
 * 优先用 Module32 按进程名匹配主模块基址（避免 EnumProcessModules 首项不是 exe）。
 */
function getMainModuleBase(api, hProcess, pid, processName) {
  const target = String(processName || "").toLowerCase();
  const flags = TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32;
  const snap = api.CreateToolhelp32Snapshot(flags, pid >>> 0);
  if (!api.isNullHandle(snap)) {
    try {
      const entry = {
        dwSize: api.moduleEntrySize,
        th32ModuleID: 0,
        th32ProcessID: 0,
        GlblcntUsage: 0,
        ProccntUsage: 0,
        modBaseAddr: 0,
        modBaseSize: 0,
        hModule: 0,
        szModule: "",
        szExePath: "",
      };
      if (api.Module32FirstW(snap, entry)) {
        do {
          const name = String(entry.szModule || "").toLowerCase();
          let base = 0n;
          try {
            if (typeof entry.modBaseAddr === "bigint") base = entry.modBaseAddr;
            else if (entry.modBaseAddr != null) base = BigInt(entry.modBaseAddr);
          } catch {
            base = 0n;
          }
          if (name === target && base !== 0n) {
            return { ok: true, base, moduleName: name, via: "Module32" };
          }
          entry.dwSize = api.moduleEntrySize;
        } while (api.Module32NextW(snap, entry));
      }
    } finally {
      api.CloseHandle(snap);
    }
  }

  // 回退：EnumProcessModulesEx，按模块名匹配；找不到则用第一项
  for (const listFlag of [LIST_MODULES_ALL, LIST_MODULES_32BIT, LIST_MODULES_64BIT]) {
    const needed = [0];
    const probe = Buffer.alloc(8);
    if (!api.EnumProcessModulesEx(hProcess, probe, 8, needed, listFlag)) continue;
    const bytes = needed[0] | 0;
    if (bytes < 8) continue;
    const count = Math.floor(bytes / 8);
    const buf = Buffer.alloc(Math.max(bytes, 8));
    if (!api.EnumProcessModulesEx(hProcess, buf, buf.length, needed, listFlag)) continue;

    let first = null;
    for (let i = 0; i < count; i++) {
      const hMod = buf.readBigUInt64LE(i * 8);
      if (hMod === 0n) continue;
      if (first == null) first = hMod;
      const name = readModuleBaseName(api, hProcess, hMod).toLowerCase();
      if (name && name === target) {
        return { ok: true, base: hMod, moduleName: name, via: "EnumProcessModulesEx" };
      }
    }
    if (first != null) {
      const name = readModuleBaseName(api, hProcess, first) || "(first)";
      return { ok: true, base: first, moduleName: name, via: "EnumProcessModulesEx/first" };
    }
  }

  return { ok: false, error: "无法获取主模块基址（Module32/EnumProcessModules 均失败）" };
}

function readPointer(api, hProcess, address, ptrSize) {
  const res = readBytes(api, hProcess, address, ptrSize);
  if (!res.ok) return { ok: false, ...res };
  const value = ptrSize === 4 ? BigInt(res.buf.readUInt32LE(0)) : res.buf.readBigUInt64LE(0);
  return { ok: true, value };
}

function readI32(api, hProcess, address) {
  const res = readBytes(api, hProcess, address, 4);
  if (!res.ok) return { ok: false, ...res };
  return { ok: true, value: res.buf.readInt32LE(0) };
}

function resolveChainValue(api, hProcess, moduleBase, moduleOffset, offsets, ptrSize) {
  if (!offsets.length) return { ok: false, error: "empty offsets" };

  const staticAddr = moduleBase + BigInt(moduleOffset >>> 0);
  const first = readPointer(api, hProcess, staticAddr, ptrSize);
  if (!first.ok) {
    return {
      ok: false,
      error: `read static base failed @ ${hexAddr(staticAddr)} = module ${hexAddr(moduleBase)} + ${hexOff(moduleOffset)} (ptr${ptrSize}) err=${first.error || "?"} lastError=${first.lastError ?? "?"} ${first.hint || ""}`.trim(),
      step: 0,
      staticAddr,
      moduleBase,
      ptrSize,
      lastError: first.lastError,
      detail: first.error,
    };
  }
  let ptr = first.value;
  if (ptr === 0n) {
    return {
      ok: false,
      error: `static pointer is NULL @ ${hexAddr(staticAddr)} (ptr${ptrSize})`,
      step: 0,
      staticAddr,
      moduleBase,
      ptrSize,
    };
  }

  const steps = [{ addr: hexAddr(staticAddr), ptr: hexAddr(ptr) }];
  for (let i = 0; i < offsets.length - 1; i++) {
    const addr = ptr + BigInt(offsets[i] >>> 0);
    const next = readPointer(api, hProcess, addr, ptrSize);
    if (!next.ok) {
      return {
        ok: false,
        error: `pointer chain RPM fail at offset[${i}]=${hexOff(offsets[i])} @ ${hexAddr(addr)} (ptr${ptrSize}) err=${next.error || "?"} lastError=${next.lastError ?? "?"}`,
        step: i + 1,
        steps,
        failAddr: addr,
        ptrSize,
        lastError: next.lastError,
      };
    }
    if (next.value === 0n) {
      return {
        ok: false,
        error: `pointer chain NULL at offset[${i}]=${hexOff(offsets[i])} @ ${hexAddr(addr)} (ptr${ptrSize})`,
        step: i + 1,
        steps,
        failAddr: addr,
        ptrSize,
      };
    }
    ptr = next.value;
    steps.push({ addr: hexAddr(addr), ptr: hexAddr(ptr) });
  }

  const lastOff = offsets[offsets.length - 1] >>> 0;
  const finalAddr = ptr + BigInt(lastOff);
  const val = readI32(api, hProcess, finalAddr);
  if (!val.ok) {
    return {
      ok: false,
      error: `read int32 failed @ ${hexAddr(finalAddr)} (last+${hexOff(lastOff)}) err=${val.error || "?"} lastError=${val.lastError ?? "?"}`,
      step: offsets.length,
      steps,
      finalAddr,
      ptrSize,
      lastError: val.lastError,
    };
  }
  return { ok: true, value: val.value, finalAddr, moduleBase, staticAddr, steps, ptrSize };
}

function pollOnce() {
  try {
    pollOnceInner();
  } catch (e) {
    emitStatus("error", `ex:${e.message}`, `轮询异常: ${e.message}`, {
      stack: String(e.stack || "")
        .split("\n")
        .slice(0, 3)
        .join(" | "),
    });
  }
}

function pollOnceInner() {
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

  enableSeDebugPrivilege(api);

  const access = PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | 0x1000; // + PROCESS_QUERY_LIMITED_INFORMATION
  const hProcess = api.OpenProcess(access, false, found.pid);
  if (api.isNullHandle(hProcess)) {
    emitStatus("error", `open:${found.pid}`, `OpenProcess 失败 pid=${found.pid} lastError=${api.GetLastError()}（请尝试以管理员运行）`, {
      pid: found.pid,
    });
    return;
  }

  try {
    const ptrSize = resolvePtrSize(api, hProcess, currentConfig.pointerSize);
    const mod = getMainModuleBase(api, hProcess, found.pid, currentConfig.processName);
    if (!mod.ok) {
      emitStatus("error", `mod:${found.pid}`, `获取模块基址失败: ${mod.error}`, { pid: found.pid });
      return;
    }

    const staticAddr = mod.base + BigInt(currentConfig.moduleOffset >>> 0);
    const result = resolveChainValue(
      api,
      hProcess,
      mod.base,
      currentConfig.moduleOffset,
      currentConfig.offsets,
      ptrSize
    );

    if (!result.ok) {
      emitStatus("warn", `chain:${result.error}`, `指针链读取失败: ${result.error}`, {
        pid: found.pid,
        moduleBase: hexAddr(mod.base),
        moduleName: mod.moduleName,
        moduleVia: mod.via,
        staticAddr: hexAddr(staticAddr),
        configuredPtrSize: currentConfig.pointerSize,
        ptrSize,
        lastError: result.lastError,
        step: result.step,
      });
      return;
    }

    const value = result.value;
    emitStatus(
      "ok",
      `ok:${found.pid}:${value}:${armed ? 1 : 0}:${result.ptrSize}`,
      `监听成功 value=${value} armed=${armed ? "yes" : "no"} ptr${result.ptrSize} final=${hexAddr(result.finalAddr)}`,
      {
        pid: found.pid,
        processName: currentConfig.processName,
        moduleName: mod.moduleName,
        moduleBase: hexAddr(mod.base),
        staticAddr: hexAddr(result.staticAddr),
        finalAddr: hexAddr(result.finalAddr),
        ptrSize: result.ptrSize,
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
  emitLog(
    "info",
    `内存监控已启动 process=${normalized.processName} static=${hexOff(normalized.moduleOffset)} ptr=${normalized.pointerSize || "auto"} offsets=[${normalized.offsets.map(hexOff).join(", ")}]`,
    {
      processName: normalized.processName,
      moduleOffset: hexOff(normalized.moduleOffset),
      pointerSize: normalized.pointerSize,
      offsets: normalized.offsets.map(hexOff),
    }
  );
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
    `${wasRunning ? "监控配置已更新" : "内存监控已启动"} process=${normalized.processName} static=${hexOff(normalized.moduleOffset)} ptr=${normalized.pointerSize || "auto"} offsets=[${normalized.offsets.map(hexOff).join(", ")}]`,
    {
      processName: normalized.processName,
      moduleOffset: hexOff(normalized.moduleOffset),
      pointerSize: normalized.pointerSize,
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
