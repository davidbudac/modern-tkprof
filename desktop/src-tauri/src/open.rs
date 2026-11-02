//! Trace files handed to the app from outside: the command line (`mtkprof-desktop a.trc b.trc`,
//! `mtkprof open`), a second launch (the single-instance plugin forwards its argv and cwd), and on
//! macOS the Finder / Dock / `open -a mtkprof` (`RunEvent::Opened`). Each request is one trace set
//! (one tab). Requests wait in a queue until the UI takes them (`take_open_requests`) once its
//! engine is ready; `app://open` tells it that one arrived.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const EVENT: &str = "app://open";

#[derive(Default)]
pub struct OpenQueue(Mutex<Vec<Vec<String>>>);

/// The paths among `args` (argv without the program name), made absolute against `cwd`. Flags
/// (`-psn_…` of old macOS launches, anything with a leading dash) are skipped.
pub fn paths_of_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            let abs = if p.is_absolute() { p } else { cwd.join(p) };
            abs.to_string_lossy().into_owned()
        })
        .collect()
}

/// Queues one trace set and tells the UI; brings the window to the front.
pub fn request(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    log::info!("open request: {paths:?}");
    app.state::<OpenQueue>().0.lock().unwrap().push(paths);
    let _ = app.emit(EVENT, ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The argv of this launch.
pub fn request_from_argv(app: &AppHandle) {
    let cwd = std::env::current_dir().unwrap_or_default();
    request(app, paths_of_args(std::env::args().skip(1), &cwd));
}

/// The trace sets asked for since the last call (the UI opens each as a tab).
#[tauri::command]
pub fn take_open_requests(queue: tauri::State<'_, OpenQueue>) -> Vec<Vec<String>> {
    std::mem::take(&mut *queue.0.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_become_absolute_paths_without_flags() {
        let cwd = if cfg!(windows) {
            PathBuf::from(r"C:\traces")
        } else {
            PathBuf::from("/traces")
        };
        let abs = if cfg!(windows) {
            r"D:\x\b.trc"
        } else {
            "/x/b.trc"
        };
        let got = paths_of_args(
            ["a.trc".into(), "-psn_0_123".into(), abs.into(), "".into()],
            &cwd,
        );
        assert_eq!(
            got,
            vec![
                cwd.join("a.trc").to_string_lossy().into_owned(),
                abs.to_string()
            ]
        );
    }
}
