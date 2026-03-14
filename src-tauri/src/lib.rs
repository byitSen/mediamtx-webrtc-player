use std::path::Path;

use base64::Engine;

#[tauri::command]
fn save_screenshot(
    base_dir: String,
    relative_path: String,
    base64_png: String,
) -> Result<(), String> {
    if relative_path.contains("..") || Path::new(&relative_path).is_absolute() {
        return Err("invalid relative_path: must not contain '..' or be absolute".to_string());
    }
    let full_path = Path::new(&base_dir).join(&relative_path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_png)
        .map_err(|e| e.to_string())?;
    std::fs::write(&full_path, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_screenshot])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
