use super::{SystemTrayManager, SYSTEMTRAY_MANAGER};
use crate::globals::TAURI_APP_HANDLE;
use tauri::Manager;

#[tauri::command]
#[oyasumivr_macros::command_profiling]
pub async fn set_close_to_system_tray(enabled: bool) {
    let mut manager_guard = SYSTEMTRAY_MANAGER.lock().await;
    let manager: &mut SystemTrayManager = manager_guard.as_mut().unwrap();
    manager.close_to_tray = enabled;
}

#[tauri::command]
#[oyasumivr_macros::command_profiling]
pub async fn complete_app_close() {
    {
        let mut manager_guard = SYSTEMTRAY_MANAGER.lock().await;
        let manager: &mut SystemTrayManager = manager_guard.as_mut().unwrap();
        manager.allow_real_close_once = true;
    }

    let app_guard = TAURI_APP_HANDLE.lock().await;
    let app = app_guard.as_ref().unwrap();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}
