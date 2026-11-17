//! Dynamic Dock: a dock that takes the Windows 11 taskbar's place.
//!
//! Rust does the system work (see the modules below); the dock and its
//! settings are two small web pages. Only the dock window lives all the
//! time; the settings window is created when opened and destroyed when
//! closed, so it costs nothing in between.

mod apps;
mod audio;
mod config;
mod icons;
mod log;
mod media;
mod shell;
mod system;
mod tasks;
mod volume;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const SETTINGS: &str = "settings";

/// Runs in the helper process started by the dock (see `main.rs`).
pub fn watchdog(pid: u32) {
    shell::watchdog(pid);
}

/// `--restore-taskbar`: put the Windows taskbar back and quit.
pub fn restore_taskbar_now() {
    shell::restore_command();
}

/// The dock page says it is drawn and running, once a second.
#[tauri::command]
fn dock_alive() {
    shell::heartbeat();
}

/// An error from one of the pages, for the log file.
#[tauri::command]
fn log_message(message: String) {
    let message: String = message.chars().take(2000).collect();
    log::write(&format!("page: {message}"));
}

/* ---------------- click-through ---------------- */

/// A painted area of the dock page, in CSS pixels. Outside every one of
/// them, clicks fall through to whatever is under the dock window.
#[derive(Clone, Copy, Default, serde::Deserialize)]
struct HitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl HitRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

static HIT_RECTS: Mutex<Vec<HitRect>> = Mutex::new(Vec::new());
/// A pop-up is open: tell the page about clicks outside the dock.
static WATCH_OUTSIDE: AtomicBool = AtomicBool::new(false);

/// How often the pointer is checked while it is near the dock, and while
/// it is far away.
const HIT_NEAR: Duration = Duration::from_millis(30);
const HIT_FAR: Duration = Duration::from_millis(120);

fn spawn_click_through(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("hit-test".into())
        .spawn(move || {
            let mut ignoring: Option<bool> = None;
            let mut was_down = false;
            loop {
                let Some(window) = app.get_webview_window(shell::DOCK) else {
                    std::thread::sleep(HIT_FAR);
                    continue;
                };
                let (Ok(cursor), Ok(origin), Ok(size), Ok(scale)) = (
                    app.cursor_position(),
                    window.outer_position(),
                    window.outer_size(),
                    window.scale_factor(),
                ) else {
                    std::thread::sleep(HIT_FAR);
                    continue;
                };
                let x = (cursor.x - origin.x as f64) / scale;
                let y = (cursor.y - origin.y as f64) / scale;
                let in_window = cursor.x >= origin.x as f64
                    && cursor.y >= origin.y as f64
                    && cursor.x < origin.x as f64 + size.width as f64
                    && cursor.y < origin.y as f64 + size.height as f64;
                let inside = in_window
                    && HIT_RECTS
                        .lock()
                        .map(|rects| rects.iter().any(|r| r.contains(x, y)))
                        .unwrap_or(false);
                let ignore = !inside;
                if ignoring != Some(ignore) && window.set_ignore_cursor_events(ignore).is_ok() {
                    if ignore && ignoring == Some(false) {
                        let _ = window.emit_to(shell::DOCK, "pointer://leave", ());
                    }
                    ignoring = Some(ignore);
                }
                if WATCH_OUTSIDE.load(Ordering::Relaxed) {
                    let down = mouse_down();
                    if down && !was_down && !inside {
                        let _ = window.emit_to(shell::DOCK, "pointer://outside", ());
                    }
                    was_down = down;
                }
                std::thread::sleep(if in_window { HIT_NEAR } else { HIT_FAR });
            }
        })
        .ok();
}

#[cfg(windows)]
fn mouse_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 || (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(windows))]
fn mouse_down() -> bool {
    false
}

/* ---------------- the dock window's styles ---------------- */

/// Takes the keyboard focus only while a pop-up needs typing (notes,
/// timers). Through Tauri, so the window library's own style bookkeeping
/// stays right (it re-applies its styles on every click-through change).
#[cfg(windows)]
fn set_dock_focusable(app: &AppHandle, focusable: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let Some(window) = app.get_webview_window(shell::DOCK) else { return };
    let _ = window.set_focusable(focusable);
    if focusable {
        if let Ok(raw) = window.hwnd() {
            unsafe {
                let _ = SetForegroundWindow(HWND(raw.0 as _));
            }
        }
        let _ = window.set_focus();
    }
}

#[cfg(not(windows))]
fn set_dock_focusable(_app: &AppHandle, _focusable: bool) {}

/// Signing out or shutting down ends the process without an exit event;
/// catch the session end on the dock window and put the taskbar back.
#[cfg(windows)]
fn watch_session_end(app: &AppHandle) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::WM_ENDSESSION;

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_ENDSESSION && w.0 != 0 {
            shell::shutdown();
        }
        DefSubclassProc(hwnd, msg, w, l)
    }

    let Some(window) = app.get_webview_window(shell::DOCK) else { return };
    let Ok(raw) = window.hwnd() else { return };
    let hwnd = raw.0 as isize;
    let _ = app.run_on_main_thread(move || unsafe {
        let _ = SetWindowSubclass(HWND(hwnd as _), Some(proc), 0xD0C, 0);
    });
}

#[cfg(not(windows))]
fn watch_session_end(_app: &AppHandle) {}

/* ---------------- settings window ---------------- */

fn open_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Dynamic Dock")
        .inner_size(1060.0, 740.0)
        .min_inner_size(820.0, 560.0)
        .center()
        .visible(false)
        .build();
}

/* ---------------- hotkeys ---------------- */

static HOTKEYS: Mutex<Vec<(u32, &'static str)>> = Mutex::new(Vec::new());
static HOTKEY_CONFIG: Mutex<Option<config::Hotkeys>> = Mutex::new(None);

/// Registers the hotkeys from the settings (again, when they changed).
fn apply_hotkeys(app: &AppHandle) {
    let wanted = config::hotkeys();
    {
        let Ok(mut last) = HOTKEY_CONFIG.lock() else { return };
        if last.as_ref() == Some(&wanted) {
            return;
        }
        *last = Some(wanted.clone());
    }
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = Vec::new();
    for (accel, action) in [
        (&wanted.next_bar, "nextBar"),
        (&wanted.previous_bar, "previousBar"),
        (&wanted.bar1, "bar1"),
        (&wanted.bar2, "bar2"),
        (&wanted.bar3, "bar3"),
        (&wanted.toggle_dock, "toggleDock"),
    ] {
        if accel.trim().is_empty() {
            continue;
        }
        if let Ok(shortcut) = accel.parse::<Shortcut>() {
            if gs.register(shortcut).is_ok() {
                map.push((shortcut.id(), action));
            }
        }
    }
    if let Ok(mut h) = HOTKEYS.lock() {
        *h = map;
    }
}

/* ---------------- commands ---------------- */

#[tauri::command]
fn get_config() -> Value {
    config::get()
}

#[tauri::command]
fn save_config(value: Value, app: AppHandle) -> Result<(), String> {
    config::set(&app, value)?;
    apply_hotkeys(&app);
    Ok(())
}

#[tauri::command]
fn shell_env() -> shell::Env {
    shell::env()
}

#[tauri::command]
fn tasks_list() -> Vec<tasks::TaskWindow> {
    tasks::snapshot()
}

#[tauri::command]
async fn task_action(hwnd: i64, action: String) -> Result<(), String> {
    tasks::act(hwnd, &action)
}

#[tauri::command]
async fn get_icons(keys: Vec<String>) -> HashMap<String, Option<String>> {
    icons::get_many(keys)
}

#[tauri::command]
async fn installed_apps() -> Vec<apps::InstalledApp> {
    apps::installed_apps()
}

#[tauri::command]
async fn launch(target: String, args: Option<String>, admin: Option<bool>) -> Result<(), String> {
    apps::launch(&target, args.as_deref().unwrap_or(""), admin.unwrap_or(false))
}

#[tauri::command]
async fn launch_app(id: String) -> Result<(), String> {
    apps::launch_app(&id)
}

#[tauri::command]
async fn shortcut(name: String) -> Result<(), String> {
    apps::shortcut(&name)
}

#[tauri::command]
async fn tray_apps() -> Vec<apps::TrayApp> {
    apps::tray_apps()
}

#[tauri::command]
async fn recycle_bin() -> apps::RecycleBin {
    apps::recycle_bin()
}

#[tauri::command]
async fn empty_recycle_bin() -> Result<(), String> {
    apps::empty_recycle_bin()
}

#[tauri::command]
async fn power(action: String) -> Result<(), String> {
    apps::power(&action)
}

#[tauri::command]
fn set_stats_interval(ms: u32) {
    system::set_interval(ms);
}

#[tauri::command]
fn media_state() -> media::MediaState {
    media::snapshot()
}

#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    media::control(&action)
}

#[tauri::command]
async fn media_seek(position_ms: u64) -> Result<(), String> {
    media::seek(position_ms)
}

#[tauri::command]
fn audio_devices() -> audio::AudioState {
    audio::snapshot()
}

#[tauri::command]
async fn audio_set_default(id: String) -> Result<(), String> {
    audio::set_default(&id)
}

#[tauri::command]
async fn volume_get() -> Result<volume::Volume, String> {
    volume::get()
}

#[tauri::command]
async fn volume_change(level: Option<f32>, delta: Option<f32>, mute: Option<bool>) -> Result<volume::Volume, String> {
    volume::change(level, delta, mute)
}

#[tauri::command]
fn set_hit_rects(rects: Vec<HitRect>) {
    if let Ok(mut r) = HIT_RECTS.lock() {
        *r = rects;
    }
}

#[tauri::command]
fn set_watch_outside(on: bool) {
    WATCH_OUTSIDE.store(on, Ordering::Relaxed);
}

#[tauri::command]
fn dock_focus(focus: bool, app: AppHandle) {
    set_dock_focusable(&app, focus);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

/// The settings page shows its window once it has painted, so it never
/// flashes white.
#[tauri::command]
fn settings_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    shell::shutdown();
    app.exit(0);
}

/// "Show the Windows taskbar for now" (tray), not saved in the settings.
#[tauri::command]
fn set_taskbar_paused(paused: bool, app: AppHandle) {
    shell::set_paused(paused);
    if let Some(item) = app.try_state::<TrayPauseItem>() {
        let _ = item.0.set_checked(paused);
    }
}

/* ---------------- tray ---------------- */

struct TrayPauseItem(CheckMenuItem<Wry>);

struct TrayItems {
    settings: MenuItem<Wry>,
    restart: MenuItem<Wry>,
    exit: MenuItem<Wry>,
}

/// Relabels the tray menu in the language picked in Settings.
#[tauri::command]
fn set_tray_labels(labels: HashMap<String, String>, app: AppHandle) {
    for (id, text) in &labels {
        let _ = match id.as_str() {
            "settings" => app.try_state::<TrayItems>().map(|i| i.settings.set_text(text)),
            "restart" => app.try_state::<TrayItems>().map(|i| i.restart.set_text(text)),
            "exit" => app.try_state::<TrayItems>().map(|i| i.exit.set_text(text)),
            "pause" => app.try_state::<TrayPauseItem>().map(|i| i.0.set_text(text)),
            _ => None,
        };
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Show the Windows taskbar for now", true, false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Dynamic Dock", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&settings, &pause, &sep, &restart, &exit])?;
    app.manage(TrayPauseItem(pause));
    app.manage(TrayItems { settings, restart, exit });

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Dynamic Dock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => open_settings_window(app),
            "pause" => {
                if let Some(item) = app.try_state::<TrayPauseItem>() {
                    // The item has already flipped its own tick.
                    let paused = item.0.is_checked().unwrap_or(false);
                    shell::set_paused(paused);
                }
            }
            "restart" => {
                shell::shutdown();
                app.restart();
            }
            "exit" => {
                shell::shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_settings_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/* ---------------- start ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Whatever goes wrong, the user gets their taskbar back.
    log::init();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::write(&format!("panic: {info}"));
        shell::shutdown();
        default_hook(info);
    }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_settings_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let action = HOTKEYS
                        .lock()
                        .ok()
                        .and_then(|h| h.iter().find(|(id, _)| *id == shortcut.id()).map(|(_, a)| *a));
                    if let Some(action) = action {
                        let _ = app.emit_to(shell::DOCK, "hotkey://action", action);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            shell_env,
            tasks_list,
            task_action,
            get_icons,
            installed_apps,
            launch,
            launch_app,
            shortcut,
            tray_apps,
            recycle_bin,
            empty_recycle_bin,
            power,
            set_stats_interval,
            media_state,
            media_control,
            media_seek,
            audio_devices,
            audio_set_default,
            volume_get,
            volume_change,
            set_hit_rects,
            set_watch_outside,
            dock_focus,
            open_settings,
            settings_ready,
            quit_app,
            set_taskbar_paused,
            set_tray_labels,
            dock_alive,
            log_message
        ])
        .setup(|app| {
            let handle = app.handle();
            config::load(handle);
            build_tray(handle)?;
            set_dock_focusable(handle, false);
            watch_session_end(handle);
            spawn_click_through(handle);
            shell::init(handle);
            tasks::init(handle);
            media::init(handle);
            audio::init(handle);
            system::init(handle);
            apply_hotkeys(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Dynamic Dock");

    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            log::write("exiting");
            shell::shutdown();
        }
    });
}
