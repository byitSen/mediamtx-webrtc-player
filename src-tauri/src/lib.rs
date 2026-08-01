mod memory_watch;
mod rtsp_proxy;

use memory_watch::{update_memory_watch, MemoryWatchConfig, MemoryWatchState};
use rtsp_proxy::RtspProxyManager;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct AppState {
    proxy: Arc<RtspProxyManager>,
    memory: MemoryWatchState,
}

#[tauri::command]
async fn start_rtsp_proxy(state: State<'_, AppState>, rtsp_url: String) -> Result<String, String> {
    state
        .proxy
        .start_proxy(rtsp_url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_rtsp_proxy(state: State<'_, AppState>, rtsp_url: String) -> Result<(), String> {
    state.proxy.stop_proxy(&rtsp_url);
    Ok(())
}

#[tauri::command]
fn stop_all_rtsp_proxies(state: State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop_all();
    Ok(())
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn save_screenshot(base_dir: String, relative_path: String, base64_png: String) -> Result<(), String> {
    if base_dir.is_empty() || relative_path.is_empty() || base64_png.is_empty() {
        return Err("missing args".into());
    }
    if relative_path.contains("..") || PathBuf::from(&relative_path).is_absolute() {
        return Err("invalid path".into());
    }
    let full = PathBuf::from(&base_dir).join(&relative_path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = base64_png
        .strip_prefix("data:image/jpeg;base64,")
        .or_else(|| base64_png.strip_prefix("data:image/png;base64,"))
        .unwrap_or(&base64_png);
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, raw)
        .map_err(|e| e.to_string())?;
    fs::write(&full, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn choose_save_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder.map(|p| p.to_string()));
    });
    Ok(rx.await.unwrap_or(None))
}

#[tauri::command]
fn set_window_size(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    let w = width.clamp(520, 8192);
    let h = height.clamp(420, 8192);
    if let Some(win) = app.get_webview_window("main") {
        // Windows：最大化状态下 set_size 常被忽略
        let _ = win.unmaximize();
        win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: w as f64,
            height: h as f64,
        }))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_window_size(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    if let Some(win) = app.get_webview_window("main") {
        // inner_size 与 set_size 一致（逻辑客户区），避免 outer 含标题栏导致越放越大
        let size = win.inner_size().map_err(|e| e.to_string())?;
        let scale = win.scale_factor().unwrap_or(1.0);
        let pos = win.outer_position().ok();
        let mut out = serde_json::json!({
            "width": (size.width as f64 / scale).round() as u32,
            "height": (size.height as f64 / scale).round() as u32,
        });
        if let Some(p) = pos {
            out["x"] = serde_json::json!(((p.x as f64) / scale).round() as i32);
            out["y"] = serde_json::json!(((p.y as f64) / scale).round() as i32);
        }
        return Ok(Some(out));
    }
    Ok(None)
}

/// 当前窗口所在显示器的逻辑分辨率（用于单画面全屏铺满屏幕）
#[tauri::command]
fn get_screen_size(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    if let Some(win) = app.get_webview_window("main") {
        let monitor = win
            .current_monitor()
            .map_err(|e| e.to_string())?
            .or_else(|| win.primary_monitor().ok().flatten());
        if let Some(m) = monitor {
            let scale = m.scale_factor();
            let size = m.size();
            let width = ((size.width as f64) / scale).round().max(1.0) as u32;
            let height = ((size.height as f64) / scale).round().max(1.0) as u32;
            let pos = m.position();
            let x = ((pos.x as f64) / scale).round() as i32;
            let y = ((pos.y as f64) / scale).round() as i32;
            return Ok(Some(serde_json::json!({
                "width": width,
                "height": height,
                "x": x,
                "y": y,
            })));
        }
    }
    Ok(None)
}

#[tauri::command]
fn set_window_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unmaximize();
        win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: x as f64,
            y: y as f64,
        }))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn unmaximize_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.unmaximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 恢复窗口几何（先取消最大化，再设位置与尺寸；Windows 必需）
#[tauri::command]
fn restore_window_geometry(
    app: AppHandle,
    width: u32,
    height: u32,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    let w = width.clamp(520, 8192);
    let h = height.clamp(420, 8192);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unmaximize();
        if let (Some(px), Some(py)) = (x, y) {
            let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: px as f64,
                y: py as f64,
            }));
        }
        win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: w as f64,
            height: h as f64,
        }))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn register_screenshot_shortcut(app: AppHandle, accelerator: Option<String>) -> Result<(), String> {
    // unregister previous by clearing all app shortcuts we manage — plugin API per-shortcut
    let _ = app.global_shortcut().unregister_all();
    let Some(acc) = accelerator.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    // Normalize Electron-style to something parseable: CommandOrControl -> CmdOrCtrl
    let normalized = acc
        .replace("CommandOrControl", "CmdOrCtrl")
        .replace("Control", "Ctrl")
        .replace("Command", "Cmd");
    let shortcut: Shortcut = normalized
        .parse()
        .map_err(|e| format!("无效快捷键: {} ({})", normalized, e))?;
    let app2 = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app2.emit("screenshot-trigger", ());
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn configure_memory_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    config: MemoryWatchConfig,
) -> Result<serde_json::Value, String> {
    update_memory_watch(app, &state.memory, config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let proxy = Arc::new(RtspProxyManager::new(app.handle().clone()));
            let memory = MemoryWatchState::new();
            app.manage(AppState { proxy, memory });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.proxy.stop_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_rtsp_proxy,
            stop_rtsp_proxy,
            stop_all_rtsp_proxies,
            get_app_version,
            get_platform,
            save_screenshot,
            choose_save_dir,
            set_window_size,
            get_window_size,
            get_screen_size,
            set_window_position,
            unmaximize_window,
            restore_window_geometry,
            register_screenshot_shortcut,
            configure_memory_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
