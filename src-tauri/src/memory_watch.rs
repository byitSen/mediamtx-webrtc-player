//! Windows memory watch (pointer-chain). Non-Windows: unsupported stub.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[cfg(windows)]
use parking_lot::Mutex;
#[cfg(windows)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWatchConfig {
    pub enabled: bool,
    pub process_name: Option<String>,
    pub module_offset: Option<String>,
    pub offsets: Option<Vec<String>>,
    pub pointer_size: Option<u8>,
    /// 读到该 int32 值时触发截图（默认 0）
    #[serde(default)]
    pub trigger_value: Option<i32>,
}

#[derive(Clone, Default)]
pub struct MemoryWatchState {
    #[cfg(windows)]
    inner: Arc<Mutex<WatchInner>>,
    #[cfg(windows)]
    generation: Arc<AtomicU64>,
}

#[cfg(windows)]
struct WatchInner {
    stop: bool,
    config: Option<MemoryWatchConfig>,
}

impl MemoryWatchState {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            Self {
                inner: Arc::new(Mutex::new(WatchInner {
                    stop: false,
                    config: None,
                })),
                generation: Arc::new(AtomicU64::new(0)),
            }
        }
        #[cfg(not(windows))]
        {
            Self::default()
        }
    }
}

#[cfg(windows)]
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    ts: u64,
    level: String,
    message: String,
}

pub fn update_memory_watch(
    app: AppHandle,
    state: &MemoryWatchState,
    cfg: MemoryWatchConfig,
) -> Result<serde_json::Value, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, state, cfg);
        return Ok(serde_json::json!({
            "ok": false,
            "reason": "仅 Windows 桌面版可用"
        }));
    }

    #[cfg(windows)]
    {
        // 新世代号：旧轮询线程看到 generation 变化后退出
        let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut g = state.inner.lock();
            g.stop = true;
            g.config = Some(cfg.clone());
        }
        std::thread::sleep(std::time::Duration::from_millis(80));
        {
            let mut g = state.inner.lock();
            g.stop = false;
        }

        if !cfg.enabled {
            let _ = app.emit(
                "memory-watch-log",
                LogEntry {
                    ts: now_ms(),
                    level: "info".into(),
                    message: "内存监控已关闭".into(),
                },
            );
            return Ok(serde_json::json!({ "ok": true, "enabled": false }));
        }

        let process_name = cfg
            .process_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("weight.exe")
            .to_string();
        let module_offset = parse_offset(cfg.module_offset.as_deref().unwrap_or("0x9B8568"));
        let offsets: Vec<u32> = cfg
            .offsets
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|s| parse_offset(s))
            .collect();
        let pointer_size = match cfg.pointer_size.unwrap_or(4) {
            4 => 4u8,
            0 => 0u8,
            _ => 8u8,
        };
        let trigger_value = cfg.trigger_value.unwrap_or(0);

        let inner = state.inner.clone();
        let generation = state.generation.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            windows_poll_loop(
                app2,
                inner,
                generation,
                gen,
                process_name,
                module_offset,
                offsets,
                pointer_size,
                trigger_value,
            );
        });

        Ok(serde_json::json!({ "ok": true, "enabled": true }))
    }
}

#[cfg(windows)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn parse_offset(s: &str) -> u32 {
    let t = s.trim();
    if t.is_empty() {
        return 0;
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).unwrap_or(0)
    } else {
        t.parse::<u32>().unwrap_or(0)
    }
}

#[cfg(windows)]
fn emit_log(app: &AppHandle, level: &str, msg: String) {
    let _ = app.emit(
        "memory-watch-log",
        LogEntry {
            ts: now_ms(),
            level: level.into(),
            message: msg,
        },
    );
}

#[cfg(windows)]
fn enable_se_debug_privilege() {
    use windows::core::w;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES,
        TOKEN_PRIVILEGES, TOKEN_QUERY, LUID_AND_ATTRIBUTES,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = Default::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .is_err()
        {
            return;
        }
        let mut luid = Default::default();
        if LookupPrivilegeValueW(None, w!("SeDebugPrivilege"), &mut luid).is_err() {
            let _ = CloseHandle(token);
            return;
        }
        let mut tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let _ = AdjustTokenPrivileges(token, false, Some(&mut tp), 0, None, None);
        let _ = CloseHandle(token);
    }
}

#[cfg(windows)]
fn windows_poll_loop(
    app: AppHandle,
    inner: Arc<Mutex<WatchInner>>,
    generation: Arc<AtomicU64>,
    my_gen: u64,
    process_name: String,
    module_offset: u32,
    offsets: Vec<u32>,
    pointer_size: u8,
    trigger_value: i32,
) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    enable_se_debug_privilege();

    let mut armed = true;
    let mut last_status_key = String::new();
    let mut last_status_at = 0u64;
    emit_log(
        &app,
        "info",
        format!(
            "内存监控已启动: {} module+{:#x} offsets={} ptr={} trigger={}",
            process_name,
            module_offset,
            offsets.len(),
            pointer_size,
            trigger_value
        ),
    );

    // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    const PROCESS_QUERY_LIMITED_INFORMATION: PROCESS_ACCESS_RIGHTS =
        PROCESS_ACCESS_RIGHTS(0x1000);
    let access = PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION;

    loop {
        if generation.load(Ordering::SeqCst) != my_gen {
            break;
        }
        {
            let g = inner.lock();
            if g.stop {
                break;
            }
            if let Some(ref c) = g.config {
                if !c.enabled {
                    break;
                }
            }
        }

        let now = now_ms();
        let pid = match find_pid_by_name(&process_name) {
            Some(p) => p,
            None => {
                if now.saturating_sub(last_status_at) > 2000 {
                    let key = format!("noproc:{}", process_name);
                    if key != last_status_key {
                        emit_log(&app, "warn", format!("未找到进程 {}", process_name));
                        last_status_key = key;
                    }
                    last_status_at = now;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            }
        };

        let handle = match unsafe { OpenProcess(access, false, pid) } {
            Ok(h) => h,
            Err(e) => {
                if now.saturating_sub(last_status_at) > 2000 {
                    emit_log(
                        &app,
                        "error",
                        format!("OpenProcess 失败 pid={} ({})，可尝试管理员运行", pid, e),
                    );
                    last_status_at = now;
                    last_status_key = format!("open:{}", pid);
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
                continue;
            }
        };

        let base = module_base(pid, &process_name);
        if base == 0 {
            unsafe {
                let _ = CloseHandle(handle);
            }
            if now.saturating_sub(last_status_at) > 2000 {
                emit_log(&app, "error", format!("获取模块基址失败 pid={}", pid));
                last_status_at = now;
                last_status_key = format!("mod:{}", pid);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
            continue;
        }

        let ptr_width = if pointer_size == 0 {
            if is_wow64(handle) {
                4
            } else {
                8
            }
        } else {
            pointer_size
        };

        let start = base.wrapping_add(module_offset as u64);
        let mut value: Option<i32> = None;
        let mut final_addr = start;
        let mut chain_ok = true;

        if offsets.is_empty() {
            value = read_i32(handle, start);
        } else if let Some(mut p) = read_ptr(handle, start, ptr_width) {
            let last = offsets.len() - 1;
            for (i, off) in offsets.iter().enumerate() {
                let at = p.wrapping_add(*off as u64);
                if i == last {
                    final_addr = at;
                    value = read_i32(handle, at);
                    if value.is_none() {
                        chain_ok = false;
                    }
                } else {
                    match read_ptr(handle, at, ptr_width) {
                        Some(next) => p = next,
                        None => {
                            chain_ok = false;
                            break;
                        }
                    }
                }
            }
        } else {
            chain_ok = false;
        }

        unsafe {
            let _ = CloseHandle(handle);
        }

        if let Some(v) = value {
            if now.saturating_sub(last_status_at) > 1000 {
                emit_log(
                    &app,
                    "info",
                    format!(
                        "监听成功 value={} armed={} ptr{} final={:#x}",
                        v,
                        if armed { "yes" } else { "no" },
                        ptr_width,
                        final_addr
                    ),
                );
                last_status_at = now;
                last_status_key = format!("ok:{}:{}", pid, v);
            }
            if v == trigger_value && armed {
                armed = false;
                let _ = app.emit("screenshot-trigger", ());
                emit_log(
                    &app,
                    "trigger",
                    format!(
                        "触发截图：value={} @ {:#x}",
                        v, final_addr
                    ),
                );
            } else if v != trigger_value {
                armed = true;
            }
        } else if !chain_ok && now.saturating_sub(last_status_at) > 2000 {
            emit_log(
                &app,
                "warn",
                format!("指针链读取失败 base={:#x} start={:#x}", base, start),
            );
            last_status_at = now;
            last_status_key = format!("chain:{}", pid);
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    emit_log(&app, "info", "内存监控已停止".into());
}

#[cfg(windows)]
fn find_pid_by_name(name: &str) -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
    let mut pe = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let target = name.to_ascii_lowercase();
    let target_leaf = target.rsplit(['/', '\\']).next().unwrap_or(&target);
    unsafe {
        if Process32FirstW(snap, &mut pe).is_ok() {
            loop {
                let exe = String::from_utf16_lossy(
                    &pe.szExeFile
                        .iter()
                        .copied()
                        .take_while(|&c| c != 0)
                        .collect::<Vec<_>>(),
                )
                .to_ascii_lowercase();
                let leaf = target_leaf.trim_end_matches(".exe");
                if exe == target
                    || exe == target_leaf
                    || exe.trim_end_matches(".exe") == leaf
                {
                    let pid = pe.th32ProcessID;
                    let _ = CloseHandle(snap);
                    return Some(pid);
                }
                if Process32NextW(snap, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    None
}

#[cfg(windows)]
fn module_base(pid: u32, name: &str) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
        TH32CS_SNAPMODULE32,
    };
    let flags = TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32;
    let snap = match unsafe { CreateToolhelp32Snapshot(flags, pid) } {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let mut me = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let target = name.to_ascii_lowercase();
    let target_leaf = target.rsplit(['/', '\\']).next().unwrap_or(&target);
    let mut first_base = 0u64;
    let mut matched = 0u64;
    unsafe {
        if Module32FirstW(snap, &mut me).is_ok() {
            loop {
                let mod_name = String::from_utf16_lossy(
                    &me.szModule
                        .iter()
                        .copied()
                        .take_while(|&c| c != 0)
                        .collect::<Vec<_>>(),
                )
                .to_ascii_lowercase();
                let base = me.modBaseAddr as u64;
                if first_base == 0 {
                    first_base = base;
                }
                if mod_name == target || mod_name == target_leaf || target_leaf.ends_with(&mod_name)
                {
                    matched = base;
                    break;
                }
                if Module32NextW(snap, &mut me).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    if matched != 0 {
        matched
    } else {
        first_base
    }
}

#[cfg(windows)]
fn is_wow64(handle: windows::Win32::Foundation::HANDLE) -> bool {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::System::Threading::IsWow64Process;
    let mut wow = BOOL(0);
    unsafe {
        if IsWow64Process(handle, &mut wow).is_ok() {
            return wow.as_bool();
        }
    }
    false
}

#[cfg(windows)]
fn read_ptr(handle: windows::Win32::Foundation::HANDLE, addr: u64, width: u8) -> Option<u64> {
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    unsafe {
        if width == 4 {
            let mut v = 0u32;
            let mut read = 0usize;
            ReadProcessMemory(
                handle,
                addr as *const _,
                &mut v as *mut _ as *mut _,
                4,
                Some(&mut read),
            )
            .ok()?;
            if read != 4 {
                return None;
            }
            Some(v as u64)
        } else {
            let mut v = 0u64;
            let mut read = 0usize;
            ReadProcessMemory(
                handle,
                addr as *const _,
                &mut v as *mut _ as *mut _,
                8,
                Some(&mut read),
            )
            .ok()?;
            if read != 8 {
                return None;
            }
            // 非规范 64 位指针：高位异常时截断为 32 位（与 Electron 行为一致）
            if v > 0x0000_FFFF_FFFF_FFFFu64 && (v >> 32) != 0 {
                Some(v & 0xFFFF_FFFF)
            } else {
                Some(v)
            }
        }
    }
}

#[cfg(windows)]
fn read_i32(handle: windows::Win32::Foundation::HANDLE, addr: u64) -> Option<i32> {
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    unsafe {
        let mut v = 0i32;
        let mut read = 0usize;
        ReadProcessMemory(
            handle,
            addr as *const _,
            &mut v as *mut _ as *mut _,
            4,
            Some(&mut read),
        )
        .ok()?;
        if read != 4 {
            return None;
        }
        Some(v)
    }
}
