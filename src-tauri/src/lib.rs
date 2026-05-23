// Decision Notepad — Tauri shell entry point.
//
// The menu is built here in Rust and emits string-id events over the
// `menu-event` channel. The JavaScript side listens for those events via
// `window.__TAURI__.event.listen` and dispatches into the existing
// in-app handlers (undo, toggleCheatsheet, etc.).
//
// Keyboard accelerators are intentionally NOT attached to menu items.
// macOS would consume those keys before they reached the webview, which
// would break the JS-side SHORTCUTS routing table that owns the keyboard
// contract. The menu is a click-affordance layer over the existing
// keyboard model, not a replacement for it.

use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemKind, SubmenuBuilder},
    Emitter, Manager,
};

/// Update a menu item's visible label by its id.
///
/// macOS menus are driven from Rust; their labels don't auto-track JS
/// state. So when toggleable items like "Hide Sidebar" / "Show Sidebar"
/// flip, the JS side calls this command to keep the menu accurate.
#[tauri::command]
fn set_menu_item_label(app: tauri::AppHandle, id: String, label: String) -> Result<(), String> {
    let menu = app.menu().ok_or_else(|| "no menu set".to_string())?;
    let item = menu
        .get(&id)
        .ok_or_else(|| format!("menu item not found: {}", id))?;
    match item {
        MenuItemKind::MenuItem(mi) => mi.set_text(&label).map_err(|e| e.to_string()),
        _ => Err(format!("menu item {} is not a regular MenuItem", id)),
    }
}

#[tauri::command]
fn open_app_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&path).map_err(|err| err.to_string())?;

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");

    let status = command.arg(&path).status().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open command exited with status {status}"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_app_data_folder,
            set_menu_item_label
        ])
        // tauri-plugin-dialog: native Save As / Open dialogs (`dialog.save`,
        // `dialog.open`). Wired to the JS `downloadAdapter` in app.js so the
        // browser <a download> path is replaced with a real macOS save panel.
        .plugin(tauri_plugin_dialog::init())
        // tauri-plugin-fs: filesystem read/write. Scopes are declared in
        // capabilities/default.json — without them, JS calls will be denied.
        .plugin(tauri_plugin_fs::init())
        // tauri-plugin-window-state: remembers window position and size
        // across launches. State saved to the OS app data directory on
        // close, restored at startup. No JS interaction needed.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Build and attach the native menu.
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // Single menu-event handler. Forwards the menu item id to JS so
            // existing in-app handlers can do the work — keeps logic in one
            // place rather than re-implementing it in Rust.
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();
                log::info!("menu event: {}", id);
                // Errors here are non-fatal (e.g. window not yet ready).
                let _ = app.emit("menu-event", id);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    // App menu (macOS): the FIRST submenu in the menu bar is always
    // adopted as the app menu by macOS — its title gets replaced with
    // the app name regardless of what we pass. So this is where About,
    // Hide, and Quit belong. If we don't put one here, macOS will hoist
    // whatever comes first (e.g. "File") into this slot instead.
    //
    // Keyboard accelerators on menu items are interpreted by macOS
    // BEFORE the webview sees the keypress — so the same key combos
    // also exist in the JS SHORTCUTS table for the browser-mode fallback,
    // but in Tauri the OS routes them through the menu_event channel.
    let settings = MenuItem::with_id(app, "open_settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, "Decision Notepad")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File menu — entry points for the export pipeline. Each item maps to
    // an existing JS handler; the export refactor already abstracted these
    // through the EXPORT_FORMATS registry, so adding more formats later is
    // a one-line change in JS plus one menu item here.
    let new_entry = MenuItem::with_id(app, "new_entry", "New Entry", true, Some("CmdOrCtrl+N"))?;
    let export_markdown = MenuItem::with_id(
        app,
        "export_markdown",
        "Export as Markdown…",
        true,
        None::<&str>,
    )?;
    let export_json = MenuItem::with_id(
        app,
        "export_json",
        "Save Notepad Backup…",
        true,
        None::<&str>,
    )?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_entry)
        .separator()
        .item(&export_markdown)
        .item(&export_json)
        .build()?;

    // Edit menu — custom Undo/Redo (route to our JS undo system) plus
    // standard predefined items (cut/copy/paste/selectAll) which let the
    // OS handle text-field editing natively.
    let undo = MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;

    // View menu — surfaces options the user might otherwise miss.
    let toggle_timestamps = MenuItem::with_id(
        app,
        "toggle_timestamps",
        "Show Timestamps",
        true,
        None::<&str>,
    )?;
    let toggle_cheatsheet = MenuItem::with_id(
        app,
        "toggle_cheatsheet",
        "Keyboard Shortcuts",
        true,
        Some("CmdOrCtrl+/"),
    )?;
    let toggle_scratch =
        MenuItem::with_id(app, "toggle_scratch", "Scratch Pad", true, None::<&str>)?;
    // Cmd+Option+S matches macOS Mail/Finder/Notes convention for sidebar
    // toggle. JS flips the label between Hide/Show Sidebar through the
    // set_menu_item_label command above.
    let toggle_sidebar = MenuItem::with_id(
        app,
        "toggle_sidebar",
        "Hide Sidebar",
        true,
        Some("CmdOrCtrl+Alt+S"),
    )?;
    let toggle_pin = MenuItem::with_id(
        app,
        "toggle_pin",
        "Always on Top",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_timestamps)
        .separator()
        .item(&toggle_cheatsheet)
        .item(&toggle_scratch)
        .item(&toggle_sidebar)
        .separator()
        .item(&toggle_pin)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file)
        .item(&edit)
        .item(&view)
        .build()?;

    Ok(menu)
}
