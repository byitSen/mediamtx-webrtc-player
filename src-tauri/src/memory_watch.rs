//! Windows memory watch (pointer-chain). Non-Windows: unsupported stub.

#![allow(dead_code)]

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
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
}

#[derive(Clone)]
pub struct MemoryWatchState {
    inner: Arc<Mutex<WatchInner>>,
}

struct WatchInner {
    stop: bool,
    config: Option<MemoryWatchConfig>,
}

impl MemoryWatchState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatchInner {
                stop: false,
                config: None,
            })),
        }
    }
}

#[derive(Serialize, Clone)]
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
        {
            let mut g = state.inner.lock();
            g.stop = true;
            g.config = Some(cfg.clone());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
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
            .clone()
            .unwrap_or_else(|| "weight.exe".into());
        let module_offset = parse_offset(cfg.module_offset.as_deref().unwrap_or("0"));
        let offsets: Vec<u32> = cfg
            .offsets
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|s| parse_offset(s))
            .collect();
        let pointer_size = match cfg.pointer_size.unwrap_or(8) {
            4 => 4u8,
            0 => 0u8,
            _ => 8u8,
        };

        let inner = state.inner.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            windows_poll_loop(app2, inner, process_name, module_offset, offsets, pointer_size);
        });

        Ok(serde_json::json!({ "ok": true, "enabled": true }))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
fn windows_poll_loop(
    app: AppHandle,
    inner: Arc<Mutex<WatchInner>>,
    process_name: String,
    module_offset: u32,
    offsets: Vec<u32>,
    pointer_size: u8,
) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Process32FirstW, Process32NextW,
        MODULEENTRY32W, PROCESSENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Memory::ReadProcessMemory;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

    let emit = |level: &str, msg: String| {
        let _ = app.emit(
            "memory-watch-log",
            LogEntry {
                ts: now_ms(),
                level: level.into(),
                message: msg,
            },
        );
    };

    let mut armed = true;
    emit("info", format!("内存监控已启动: {}", process_name));

    loop {
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

        let pid = match find_pid_by_name(&process_name) {
            Some(p) => p,
            None => {
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            }
        };

        let access = PROCESS_VM_READ | PROCESS_QUERY_INFORMATION;
        let handle = match unsafe { OpenProcess(access, false, pid) } {
            Ok(h) => h,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(300));
                continue;
            }
        };

        let base = module_base(handle, pid, &process_name);
        if base == 0 {
            unsafe {
                let _ = CloseHandle(handle);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
            continue;
        }

        let ptr_width = if pointer_size == 0 {
            if is_wow64(handle) { 4 } else { 8 }
        } else {
            pointer_size
        };

        let mut ok = true;
        // p = *(base + module_offset); then p = *(p + off_i); last: i32(p + off_last)
        let start = base.wrapping_add(module_offset as u64);
        if offsets.is_empty() {
            if let Some(v) = read_i32(handle, start) {
                if v == 0 && armed {
                    armed = false;
                    let _ = app.emit("screenshot-trigger", ());
                    emit("info", format!("触发截图 value=0 addr={:#x}", start));
                } else if v != 0 {
                    armed = true;
                }
            }
        } else if let Some(mut p) = read_ptr(handle, start, ptr_width) {
            let last = offsets.len() - 1;
            for (i, off) in offsets.iter().enumerate() {
                let at = p.wrapping_add(*off as u64);
                if i == last {
                    match read_i32(handle, at) {
                        Some(v) => {
                            if v == 0 && armed {
                                armed = false;
                                let _ = app.emit("screenshot-trigger", ());
                                emit("info", format!("触发截图 value=0 addr={:#x}", at));
                            } else if v != 0 {
                                armed = true;
                            }
                        }
                        None => ok = false,
                    }
                } else {
                    match read_ptr(handle, at, ptr_width) {
                        Some(next) => p = next,
                        None => {
                            ok = false;
                            break;
                        }
                    }
                }
            }
            let _ = ok;
        }

        unsafe {
            let _ = CloseHandle(handle);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    emit("info", "内存监控已停止".into());
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
                if exe == target || exe.ends_with(&target) {
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
fn module_base(handle: windows::Win32::Foundation::HANDLE, pid: u32, name: &str) -> u64 {
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
    let mut base = 0u64;
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
                if mod_name == target || base == 0 {
                    base = me.modBaseAddr as u64;
                    if mod_name == target {
                        break;
                    }
                }
                if Module32NextW(snap, &mut me).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        let _ = handle; // silence
    }
    base
}

#[cfg(windows)]
fn is_wow64(_handle: windows::Win32::Foundation::HANDLE) -> bool {
    false
}

#[cfg(windows)]
fn read_ptr(handle: windows::Win32::Foundation::HANDLE, addr: u64, width: u8) -> Option<u64> {
    use windows::Win32::System::Memory::ReadProcessMemory;
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
            Some(v)
        }
    }
}

#[cfg(windows)]
fn read_i32(handle: windows::Win32::Foundation::HANDLE, addr: u64) -> Option<i32> {
    use windows::Win32::System::Memory::ReadProcessMemory;
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
