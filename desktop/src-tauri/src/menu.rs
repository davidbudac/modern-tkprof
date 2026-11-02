//! The macOS app menu. Tauri's default menu owns ⌘W through its "Close Window" items (a native
//! key equivalent reaches the menu before the webview, so the page never sees the keydown and
//! the window would close with the active tab). This is the default menu with that item turned
//! into "Close Tab" (⌘W), which tells the UI (`menu://close-tab`, see `src/workspace/shortcuts.ts`);
//! the window closes with "Close Window" (⇧⌘W) or the red button. Other platforms keep the default
//! menu: Windows and Linux bind Alt+F4 to it, not Ctrl+W.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

const CLOSE_TAB: &str = "close-tab";
const CLOSE_WINDOW: &str = "close-window";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let close_tab = MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close_tab])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
            &Submenu::with_id_and_items(
                app,
                tauri::menu::WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &close_window,
                ],
            )?,
            &Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

pub fn on_event(app: &AppHandle, ev: MenuEvent) {
    match ev.id().as_ref() {
        CLOSE_TAB => {
            let _ = app.emit("menu://close-tab", ());
        }
        CLOSE_WINDOW => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
        }
        _ => {}
    }
}
