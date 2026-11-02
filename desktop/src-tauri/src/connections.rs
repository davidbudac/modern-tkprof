//! Connections (S6): the team connections file lives anywhere the user points the setting at,
//! so its path is added to the fs plugin's scope at run time (the capability grants the read
//! commands but no static path). The dialog plugin does the same for files picked in a dialog,
//! which covers import and export.

use std::path::PathBuf;

use tauri_plugin_fs::FsExt;

/// Allows the webview to read (and stat) the team connections file at `path`: a `.json` file
/// only, the path as given and with its symbolic links resolved (the fs plugin checks the
/// resolved path).
#[tauri::command]
pub fn allow_team_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let is_json = p
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !p.is_absolute() || !is_json {
        return Err(format!(
            "team file must be an absolute path to a .json file: {path}"
        ));
    }
    let scope = app.fs_scope();
    scope.allow_file(&p).map_err(|e| e.to_string())?;
    if let Ok(real) = std::fs::canonicalize(&p) {
        scope.allow_file(real).map_err(|e| e.to_string())?;
    }
    Ok(())
}
