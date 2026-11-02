//! `app_info`: where the app keeps its files, for Settings and About, and the trace a smoke run
//! opens on start.

use serde::Serialize;
use tauri::Manager;

use crate::engine::{self, EngineManager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// the index cache the engine runs with (the setting, or the default)
    cache_dir: String,
    default_cache_dir: String,
    /// the sidecar next to the app's executable
    engine_path: String,
    /// the store files: settings.json, workspace.json, annotations.json
    data_dir: String,
    log_dir: String,
    /// `MTKPROF_SMOKE_OPEN` (smoke runs only): a trace to open on start
    smoke_open: Option<String>,
}

fn engine_path() -> String {
    let name = format!("mtkprof-engine{}", std::env::consts::EXE_SUFFIX);
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(&name)))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(name)
}

fn dir(r: tauri::Result<std::path::PathBuf>) -> String {
    r.map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|e| format!("({e})"))
}

#[tauri::command]
pub async fn app_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineManager>,
) -> Result<AppInfo, String> {
    Ok(AppInfo {
        cache_dir: state.cache_dir(&app).await?,
        default_cache_dir: engine::default_cache_dir(&app)?,
        engine_path: engine_path(),
        data_dir: dir(app.path().app_data_dir()),
        log_dir: dir(app.path().app_log_dir()),
        smoke_open: if engine::dev_tools() {
            std::env::var("MTKPROF_SMOKE_OPEN")
                .ok()
                .filter(|s| !s.is_empty())
        } else {
            None
        },
    })
}
