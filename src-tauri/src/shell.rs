//! Taking the Windows taskbar's place.
//!
//! The dock is one transparent, always-on-top window along the bottom (or
//! top) of the primary screen. This module:
//!
//! - hides Explorer's taskbar (it is switched to auto-hide first, so it gives
//!   its screen space back) and keeps it hidden;
//! - registers the dock as an "app bar", so maximised windows stop above it,
//!   the way they stop above the taskbar;
//! - places the dock window and keeps it on top;
//! - tells the dock page when something runs full screen, when a window
//!   touches the dock (for smart auto-hide) and the system's light/dark look
//!   and accent colour.
//!
//! Putting the taskbar back is the important part. A journal file records the
//! taskbar's original state before anything changes; a clean exit, a panic,
//! the tray menu and a separate watchdog process (which notices a crash or a
//! kill from Task Manager) all restore it from there.

use serde::Serialize;

/// Label of the dock window.
pub const DOCK: &str = "dock";
/// Sent to the dock page when its surroundings change.
pub const ENV_EVENT: &str = "shell://env";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Env {
    /// A full-screen game, video or presentation is in front.
    pub fullscreen: bool,
    /// The foreground window touches the dock's strip (smart auto-hide).
    pub overlapped: bool,
    /// Windows is in light mode.
    pub light: bool,
    /// The Windows accent colour, "#rrggbb".
    pub accent: String,
    /// The Windows taskbar is hidden and the dock has its place.
    pub replaced: bool,
    /// Why the taskbar couldn't be replaced, if it couldn't.
    pub error: Option<String>,
    /// The screen's width in CSS pixels.
    pub screen_width: f64,
}

#[cfg(windows)]
pub use imp::{env, init, restore_now, set_paused, shutdown, watchdog};

#[cfg(not(windows))]
mod fallback {
    use super::Env;
    use tauri::AppHandle;

    pub fn init(_app: &AppHandle) {}
    pub fn env() -> Env {
        Env::default()
    }
    pub fn set_paused(_paused: bool) {}
    pub fn shutdown() {}
    pub fn restore_now() {}
    pub fn watchdog(_pid: u32) {}
}

#[cfg(not(windows))]
pub use fallback::{env, init, restore_now, set_paused, shutdown, watchdog};

#[cfg(windows)]
mod imp {
    use super::{Env, DOCK, ENV_EVENT};
    use crate::config;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HMONITOR, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, SHQueryUserNotificationState, ABE_BOTTOM, ABE_TOP, ABM_GETSTATE, ABM_NEW,
        ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_SETSTATE, ABS_ALWAYSONTOP, ABS_AUTOHIDE, APPBARDATA,
        QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetClassNameW, GetForegroundWindow, GetWindowRect,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetWindowPos, ShowWindow, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE,
        WM_APP,
    };

    const TICK: Duration = Duration::from_millis(200);
    /// The app-bar callback message. Nothing listens for it (the loop below
    /// notices every change itself), but Windows wants one.
    const CALLBACK: u32 = WM_APP + 0x52;

    /// Set while the app is quitting, so nothing hides the taskbar again.
    static EXITING: AtomicBool = AtomicBool::new(false);
    /// "Show the Windows taskbar for now" from the tray; not saved.
    static PAUSED: AtomicBool = AtomicBool::new(false);
    /// The taskbar is hidden by us right now.
    static REPLACED: AtomicBool = AtomicBool::new(false);
    static ENV: Mutex<Option<Env>> = Mutex::new(None);
    /// The dock window's handle, for the app-bar calls made at exit.
    static DOCK_HWND: Mutex<Option<isize>> = Mutex::new(None);
    /// The app bar is registered.
    static REGISTERED: AtomicBool = AtomicBool::new(false);

    pub fn env() -> Env {
        ENV.lock().ok().and_then(|e| e.clone()).unwrap_or_default()
    }

    pub fn set_paused(paused: bool) {
        PAUSED.store(paused, Ordering::Relaxed);
    }

    pub fn init(app: &AppHandle) {
        // A crash last time may have left the taskbar hidden: put it back
        // first; the loop takes it over again if the settings say so.
        restore_now();
        spawn_watchdog();
        let app = app.clone();
        std::thread::Builder::new()
            .name("shell".into())
            .spawn(move || run(app))
            .ok();
    }

    /// Clean exit: give the screen edge back and show the taskbar.
    pub fn shutdown() {
        EXITING.store(true, Ordering::SeqCst);
        if let Some(hwnd) = DOCK_HWND.lock().ok().and_then(|h| *h) {
            appbar_remove(HWND(hwnd as _));
        }
        restore_now();
    }

    /* ---------------- the journal ---------------- */

    fn journal_path() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("DynamicDock").join("taskbar-state.txt"))
    }

    fn read_journal() -> Option<u32> {
        let text = std::fs::read_to_string(journal_path()?).ok()?;
        text.trim().parse::<u32>().ok().map(|s| s & (ABS_AUTOHIDE | ABS_ALWAYSONTOP))
    }

    fn write_journal(state: u32) -> Result<(), String> {
        let path = journal_path().ok_or("No local app data folder")?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, state.to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    fn delete_journal() {
        if let Some(path) = journal_path() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Puts the taskbar back the way the journal says it was, if a journal
    /// is there. Safe to call any time, from any process.
    pub fn restore_now() {
        if let Some(state) = read_journal() {
            set_taskbar_state(state);
            show_native(true);
            delete_journal();
        }
        REPLACED.store(false, Ordering::Relaxed);
    }

    /* ---------------- the watchdog process ---------------- */

    fn spawn_watchdog() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe)
                .arg("--watchdog")
                .arg(std::process::id().to_string())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }

    /// Runs in the helper process: waits for the dock to end, then restores
    /// the taskbar if the dock didn't (a clean exit deletes the journal).
    pub fn watchdog(pid: u32) {
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                WaitForSingleObject(handle, INFINITE);
            }
        }
        restore_now();
    }

    /* ---------------- the Windows taskbar ---------------- */

    fn taskbar() -> Option<HWND> {
        unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok() }.filter(|h| !h.is_invalid())
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// The taskbars of the other screens.
    fn secondary_taskbars() -> Vec<HWND> {
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let list = &mut *(lparam.0 as *mut Vec<HWND>);
            if class_of(hwnd) == "Shell_SecondaryTrayWnd" {
                list.push(hwnd);
            }
            BOOL(1)
        }
        let mut list: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
        }
        list
    }

    fn get_taskbar_state() -> u32 {
        let mut data = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            ..Default::default()
        };
        (unsafe { SHAppBarMessage(ABM_GETSTATE, &mut data) } as u32) & (ABS_AUTOHIDE | ABS_ALWAYSONTOP)
    }

    fn set_taskbar_state(state: u32) {
        if get_taskbar_state() == state {
            return;
        }
        let mut data = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: taskbar().unwrap_or_default(),
            lParam: LPARAM(state as isize),
            ..Default::default()
        };
        unsafe {
            SHAppBarMessage(ABM_SETSTATE, &mut data);
        }
    }

    fn show_native(show: bool) {
        let cmd = if show { SW_SHOWNOACTIVATE } else { SW_HIDE };
        let mut all = secondary_taskbars();
        all.extend(taskbar());
        for hwnd in all {
            unsafe {
                if IsWindowVisible(hwnd).as_bool() != show {
                    let _ = ShowWindow(hwnd, cmd);
                }
            }
        }
    }

    fn start_replacing() -> Result<(), String> {
        if taskbar().is_none() {
            return Err("The Windows taskbar can't be found (Explorer may be restarting).".into());
        }
        let original = match read_journal() {
            Some(state) => state,
            None => {
                let state = get_taskbar_state();
                write_journal(state).map_err(|e| format!("The taskbar was left alone: its recovery file can't be written ({e})."))?;
                state
            }
        };
        // Auto-hide makes Explorer give back the space it keeps for the
        // taskbar; hiding it keeps it from sliding in.
        set_taskbar_state(ABS_AUTOHIDE | (original & ABS_ALWAYSONTOP));
        show_native(false);
        REPLACED.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn stop_replacing() {
        restore_now();
    }

    /* ---------------- the app bar ---------------- */

    fn appbar_data(hwnd: HWND, edge: u32, rc: RECT) -> APPBARDATA {
        APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: hwnd,
            uCallbackMessage: CALLBACK,
            uEdge: edge,
            rc,
            ..Default::default()
        }
    }

    fn appbar_remove(hwnd: HWND) {
        if REGISTERED.swap(false, Ordering::SeqCst) {
            let mut data = appbar_data(hwnd, ABE_BOTTOM, RECT::default());
            unsafe {
                SHAppBarMessage(ABM_REMOVE, &mut data);
            }
        }
    }

    /// Claims `size` physical pixels along the edge and returns the rectangle
    /// Windows gave the dock (it may sit above another app bar).
    fn appbar_set(hwnd: HWND, monitor: RECT, top: bool, size: i32) -> RECT {
        let edge = if top { ABE_TOP } else { ABE_BOTTOM };
        if !REGISTERED.load(Ordering::SeqCst) {
            let mut data = appbar_data(hwnd, edge, RECT::default());
            if unsafe { SHAppBarMessage(ABM_NEW, &mut data) } != 0 {
                REGISTERED.store(true, Ordering::SeqCst);
            }
        }
        let mut rc = monitor;
        if top {
            rc.bottom = rc.top + size;
        } else {
            rc.top = rc.bottom - size;
        }
        let mut data = appbar_data(hwnd, edge, rc);
        unsafe {
            SHAppBarMessage(ABM_QUERYPOS, &mut data);
        }
        // Windows moved the far side; keep our size from there.
        if top {
            data.rc.bottom = data.rc.top + size;
        } else {
            data.rc.top = data.rc.bottom - size;
        }
        unsafe {
            SHAppBarMessage(ABM_SETPOS, &mut data);
        }
        data.rc
    }

    /* ---------------- screens ---------------- */

    struct Screen {
        rect: RECT,
        scale: f64,
    }

    fn primary_screen() -> Option<Screen> {
        unsafe {
            let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let rect = monitor_rect(monitor)?;
            let (mut dx, mut dy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            Some(Screen {
                rect,
                scale: dx.max(96) as f64 / 96.0,
            })
        }
    }

    fn monitor_rect(monitor: HMONITOR) -> Option<RECT> {
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool().then_some(info.rcMonitor)
    }

    fn rect_of(hwnd: HWND) -> Option<RECT> {
        let mut r = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut r) }.ok().map(|_| r)
    }

    /* ---------------- what's in front ---------------- */

    fn own_window(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid == std::process::id()
    }

    const SHELL_CLASSES: [&str; 9] = [
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow",
        "MultitaskingViewFrame",
        "TaskSwitcherWnd",
        "NotifyIconOverflowWindow",
    ];

    /// A full-screen game, video or presentation on the dock's screen.
    fn fullscreen(fg: HWND, screen: &RECT) -> bool {
        if let Ok(state) = unsafe { SHQueryUserNotificationState() } {
            if [QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE].contains(&state) {
                return true;
            }
        }
        if fg.is_invalid() || own_window(fg) || SHELL_CLASSES.contains(&class_of(fg).as_str()) {
            return false;
        }
        let monitor = unsafe { MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) };
        match (rect_of(fg), monitor_rect(monitor)) {
            (Some(w), Some(m)) => {
                m == *screen && w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom
            }
            _ => false,
        }
    }

    /// The foreground window reaches into the dock's strip.
    fn overlaps(fg: HWND, strip: &RECT) -> bool {
        if fg.is_invalid() || own_window(fg) || SHELL_CLASSES.contains(&class_of(fg).as_str()) {
            return false;
        }
        unsafe {
            if IsIconic(fg).as_bool() || !IsWindowVisible(fg).as_bool() {
                return false;
            }
        }
        rect_of(fg).is_some_and(|w| {
            w.left < strip.right && w.right > strip.left && w.top < strip.bottom && w.bottom > strip.top
        })
    }

    fn read_dword(key: HKEY, sub: PCWSTR, name: PCWSTR) -> Option<u32> {
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let err = unsafe {
            RegGetValueW(
                key,
                sub,
                name,
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        };
        err.is_ok().then_some(value)
    }

    fn system_light() -> bool {
        read_dword(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("SystemUsesLightTheme"),
        ) == Some(1)
    }

    /// Stored as 0xAABBGGRR.
    fn accent_colour() -> String {
        let abgr = read_dword(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Windows\\DWM"), w!("AccentColor"))
            .unwrap_or(0xffd77800);
        let (r, g, b) = (abgr & 0xff, (abgr >> 8) & 0xff, (abgr >> 16) & 0xff);
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    /* ---------------- the loop ---------------- */

    #[derive(PartialEq, Clone, Copy)]
    struct Placement {
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    }

    fn run(app: AppHandle) {
        let mut placed: Option<Placement> = None;
        let mut reserved: Option<((RECT, bool, i32), i32)> = None;
        let mut shown = false;
        let mut last_taskbar: Option<isize> = None;
        let mut last_fg = HWND::default();
        let mut error: Option<String> = None;
        let mut ticks: u32 = 0;
        let mut look = (system_light(), accent_colour());

        loop {
            std::thread::sleep(TICK);
            ticks = ticks.wrapping_add(1);
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            let Some(window) = app.get_webview_window(DOCK) else { continue };
            let Ok(raw) = window.hwnd() else { continue };
            let hwnd = HWND(raw.0 as _);
            if let Ok(mut h) = DOCK_HWND.lock() {
                *h = Some(hwnd.0 as isize);
            }
            let cfg = config::shell();
            let Some(screen) = primary_screen() else { continue };

            // Explorer restarted: its new taskbar shows, and our app bar
            // registration went with the old one.
            let tb = taskbar().map(|h| h.0 as isize);
            if tb.is_some() && tb != last_taskbar {
                if last_taskbar.is_some() {
                    REGISTERED.store(false, Ordering::SeqCst);
                    REPLACED.store(false, Ordering::Relaxed);
                    reserved = None;
                }
                last_taskbar = tb;
            }

            // Replace the taskbar, or give it back.
            let want = cfg.replace_taskbar && !PAUSED.load(Ordering::Relaxed);
            if want && !REPLACED.load(Ordering::Relaxed) {
                error = start_replacing().err();
            } else if !want && REPLACED.load(Ordering::Relaxed) {
                stop_replacing();
                error = None;
            } else if want {
                // Explorer shows it again now and then (edge hover, Win key).
                show_native(false);
            }
            let replaced = REPLACED.load(Ordering::Relaxed);

            // Where the bar's outer edge is, in physical pixels.
            let s = screen.scale;
            let reserve = (cfg.reserve() * s).round() as i32;
            let top = cfg.top();
            let edge = if reserve > 0 {
                let key = (screen.rect, top, reserve);
                match reserved {
                    // Unchanged: no need to ask Windows again.
                    Some((k, edge)) if k == key && REGISTERED.load(Ordering::SeqCst) => edge,
                    _ => {
                        let rc = appbar_set(hwnd, screen.rect, top, reserve);
                        let edge = if top { rc.top } else { rc.bottom };
                        reserved = Some((key, edge));
                        edge
                    }
                }
            } else {
                if reserved.take().is_some() {
                    appbar_remove(hwnd);
                }
                // Not replacing and not reserving: sit just above a visible
                // Windows taskbar on the same edge.
                match (replaced, taskbar().and_then(|t| unsafe { IsWindowVisible(t) }.as_bool().then(|| rect_of(t)).flatten())) {
                    (false, Some(t)) if !top && t.top > screen.rect.top + (screen.rect.bottom - screen.rect.top) / 2 => t.top,
                    (false, Some(t)) if top && t.bottom < screen.rect.top + (screen.rect.bottom - screen.rect.top) / 2 => t.bottom,
                    _ => if top { screen.rect.top } else { screen.rect.bottom },
                }
            };

            let h = (cfg.window_height() * s).round() as i32;
            let next = Placement {
                x: screen.rect.left,
                y: if top { edge } else { edge - h },
                w: screen.rect.right - screen.rect.left,
                h,
            };
            if placed != Some(next) {
                unsafe {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), next.x, next.y, next.w, next.h, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                }
                placed = Some(next);
            }

            // Full screen, overlap and topmost.
            let fg = unsafe { GetForegroundWindow() };
            let full = cfg.hide_on_fullscreen && fullscreen(fg, &screen.rect);
            let strip_h = ((cfg.bar_height + cfg.margin * 2.0) * s).round() as i32;
            let strip = if top {
                RECT { top: edge, bottom: edge + strip_h, ..screen.rect }
            } else {
                RECT { top: edge - strip_h, bottom: edge, ..screen.rect }
            };
            let overlapped = overlaps(fg, &strip);
            if full == shown {
                unsafe {
                    let _ = ShowWindow(hwnd, if full { SW_HIDE } else { SW_SHOWNOACTIVATE });
                }
                shown = !full;
            }
            if shown && fg != last_fg {
                // Something new came to the front; stay above it.
                unsafe {
                    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                }
            }
            last_fg = fg;

            // The system look rarely changes: read it every few seconds.
            if ticks % 15 == 0 {
                look = (system_light(), accent_colour());
            }
            let next_env = Env {
                fullscreen: full,
                overlapped,
                light: look.0,
                accent: look.1.clone(),
                replaced,
                error: error.clone(),
                screen_width: (screen.rect.right - screen.rect.left) as f64 / s,
            };
            let changed = ENV.lock().map(|mut e| {
                if e.as_ref() == Some(&next_env) {
                    false
                } else {
                    *e = Some(next_env.clone());
                    true
                }
            });
            if changed.unwrap_or(false) {
                let _ = app.emit(ENV_EVENT, next_env);
            }
        }
    }
}
