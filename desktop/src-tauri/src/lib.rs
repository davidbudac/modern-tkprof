//! The mtkprof desktop shell: runs the `mtkprof-engine` sidecar (docs/PLAN-DESKTOP.md § 2 at the
//! repository root), restarts it when it crashes and hands its address and token to the UI.

mod app;
mod connections;
mod engine;
#[cfg(target_os = "macos")]
mod menu;
mod open;
mod secrets;

use std::sync::Arc;
use std::time::Duration;

use tauri::{Manager, RunEvent};
use tauri_plugin_opener::OpenerExt;

const RELEASES_URL: &str = "https://github.com/davidbudac/modern-tkprof/releases";

#[tauri::command]
fn open_releases_page(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Opens a web link in the system browser: the webview ignores `target="_blank"` (the engine
/// UI's "Open in plan viz", for one). Only http(s), so a page can't launch local files or apps.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("not a web link: {url}"));
    }
    let len = url.len();
    app.opener()
        .open_url(url, None::<&str>)
        .map(|()| log::info!("opened a web link ({len} chars)"))
        .map_err(|e| {
            log::warn!("open web link ({len} chars): {e}");
            e.to_string()
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // first: a second launch focuses the running window instead of starting another engine,
        // and hands over the trace files on its command line
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let paths = open::paths_of_args(args.into_iter().skip(1), std::path::Path::new(&cwd));
            open::request(app, paths);
        }))
        .plugin(
            // Info: at the default Trace, tao's window events filled the 40 KB file within minutes and the
            // rotation dropped everything else
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::EngineManager::default())
        .manage(open::OpenQueue::default())
        .setup(|app| {
            let keychain = secrets::Keychain::new(app.config().identifier.clone());
            app.manage(Arc::new(secrets::Secrets::new(Box::new(keychain))));
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(app.handle())?)?;
            smoke_kill(app.handle());
            open::request_from_argv(app.handle());
            Ok(())
        })
        .on_menu_event(|app, ev| {
            #[cfg(target_os = "macos")]
            menu::on_event(app, ev);
            #[cfg(not(target_os = "macos"))]
            let _ = (app, ev);
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_stop,
            engine::engine_restart,
            engine::engine_status,
            engine::engine_kill,
            engine::engine_dev_tools,
            app::app_info,
            open_releases_page,
            open_external_url,
            connections::allow_team_file,
            secrets::assist_key_answer,
            secrets::assist_key_store_and_answer,
            secrets::assist_key_forget,
            open::take_open_requests
        ])
        .build(tauri::generate_context!())
        .expect("error while building mtkprof");

    app.run(|app, ev| match ev {
        RunEvent::Exit => {
            // the engine also exits on its own when our end of its stdin closes
            let mgr = app.state::<engine::EngineManager>().inner().clone();
            tauri::async_runtime::block_on(mgr.stop());
        }
        // Finder double-click, "Open With", a drop on the Dock icon, `open -a mtkprof …`
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            open::request(app, paths);
        }
        _ => {}
    });
}

/// CI smoke runs (`MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=<seconds>`) kill the engine once,
/// that many seconds after it first reports ready, so a screenshot after it shows the automatic
/// restart.
fn smoke_kill(app: &tauri::AppHandle) {
    if !engine::dev_tools() {
        return;
    }
    let Some(secs) = std::env::var("MTKPROF_SMOKE_KILL_AFTER")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    else {
        return;
    };
    let mgr = app.state::<engine::EngineManager>().inner().clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..120 {
            if mgr.running().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        tokio::time::sleep(Duration::from_secs(secs)).await;
        if let Err(e) = mgr.kill().await {
            log::error!("smoke: kill engine: {e}");
        }
    });
}
