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

/// Label of the dock window on the primary screen. The docks on the other
/// screens are `dock-<display>`, created and closed as screens come and go.
pub const DOCK: &str = "dock";

/// Whether a window label is one of the docks.
pub fn is_dock(label: &str) -> bool {
    label == DOCK || label.starts_with("dock-")
}
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
pub use imp::{env, heartbeat, init, restore_command, set_paused, shutdown, watchdog};

#[cfg(not(windows))]
mod fallback {
    use super::Env;
    use tauri::AppHandle;

    pub fn init(_app: &AppHandle) {}
    pub fn env(_label: &str) -> Env {
        Env::default()
    }
    pub fn set_paused(_paused: bool) {}
    pub fn shutdown() {}
    pub fn restore_command() {}
    pub fn heartbeat(_label: &str) {}
    pub fn watchdog(_pid: u32) {}
}

#[cfg(not(windows))]
pub use fallback::{env, heartbeat, init, restore_command, set_paused, shutdown, watchdog};

#[cfg(windows)]
mod imp {
    use super::{is_dock, Env, DOCK, ENV_EVENT};
    use std::collections::{HashMap, HashSet};
    use crate::config;
    use crate::log::log;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
        MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, SHQueryUserNotificationState, ABE_BOTTOM, ABE_TOP, ABM_GETSTATE, ABM_NEW,
        ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_SETSTATE, ABS_ALWAYSONTOP, ABS_AUTOHIDE, APPBARDATA,
        QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, SetWindowPos, ShowWindow, GWL_STYLE,
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE,
        WM_APP, WS_CAPTION,
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
    /// Each dock's surroundings, by window label.
    static ENV: Mutex<Option<HashMap<String, Env>>> = Mutex::new(None);
    /// Dock windows registered as app bars, for the calls made at exit.
    static APPBARS: Mutex<Option<HashSet<isize>>> = Mutex::new(None);

    /* ---------------- are the dock pages alive? ---------------- */

    /// Each dock page calls `heartbeat` every second once it has drawn
    /// itself. The taskbar is only taken over while they do: a page that
    /// never loads, or a web view that crashed or hung, must never leave
    /// the user with neither the dock nor the taskbar.
    const STALE_AFTER: Duration = Duration::from_secs(15);
    static START: OnceLock<Instant> = OnceLock::new();
    /// The taskbar's own state, as this process first found it. Taking the
    /// taskbar again later (after "show it for now", a page that stopped
    /// answering, an Explorer restart) reuses it instead of reading the
    /// state again, which could still be the auto-hide we set ourselves.
    static ORIGINAL: Mutex<Option<u32>> = Mutex::new(None);
    /// Milliseconds since START of each page's last heartbeat, plus one.
    static BEATS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

    fn now_ms() -> u64 {
        START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
    }

    pub fn heartbeat(label: &str) {
        let first = BEATS
            .lock()
            .map(|mut b| b.get_or_insert_with(HashMap::new).insert(label.to_string(), now_ms()).is_none())
            .unwrap_or(false);
        if first {
            log!("dock page {label} is up");
        }
    }

    /// `None`: the page hasn't drawn yet. `Some(false)`: it stopped.
    fn page_alive(label: &str, grace_until: u64) -> Option<bool> {
        let beat = BEATS.lock().ok().and_then(|b| b.as_ref().and_then(|b| b.get(label).copied()))?;
        let now = now_ms();
        Some(now < grace_until || now.saturating_sub(beat) < STALE_AFTER.as_millis() as u64)
    }

    fn forget_page(label: &str) {
        if let Ok(mut b) = BEATS.lock() {
            if let Some(b) = b.as_mut() {
                b.remove(label);
            }
        }
        if let Ok(mut e) = ENV.lock() {
            if let Some(e) = e.as_mut() {
                e.remove(label);
            }
        }
    }

    pub fn env(label: &str) -> Env {
        ENV.lock()
            .ok()
            .and_then(|e| e.as_ref().and_then(|e| e.get(label).cloned()))
            .unwrap_or_default()
    }

    pub fn set_paused(paused: bool) {
        PAUSED.store(paused, Ordering::Relaxed);
    }

    pub fn init(app: &AppHandle) {
        now_ms();
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

    /// Clean exit: give the screen edges back and show the taskbar.
    pub fn shutdown() {
        EXITING.store(true, Ordering::SeqCst);
        let bars: Vec<isize> = APPBARS
            .lock()
            .ok()
            .and_then(|mut a| a.take())
            .map(|a| a.into_iter().collect())
            .unwrap_or_default();
        for hwnd in bars {
            appbar_send_remove(HWND(hwnd as _));
        }
        // The FPS counter's trace session would outlive the process.
        crate::fps::shutdown();
        crate::taskband::restore();
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
            log!("restoring the taskbar (state {state})");
            if apply_taskbar_state(state, Duration::from_millis(1500)) {
                delete_journal();
            } else {
                // Keep the journal: the next start (or the watchdog) uses it
                // as the original state and tries again, rather than taking
                // our auto-hide for the user's own setting.
                log!("the taskbar still reports state {}; kept its recovery file", get_taskbar_state());
            }
        }
        // Even without a journal: a hidden taskbar is never what we want
        // when restoring.
        show_native(true);
        REPLACED.store(false, Ordering::Relaxed);
    }

    /// `--restore-taskbar`: ends every other Dynamic Dock process (a running
    /// dock would hide the taskbar again at once), then restores it.
    pub fn restore_command() {
        log!("--restore-taskbar");
        let me = std::process::id();
        let name = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            .unwrap_or_else(|| "dynamic-dock.exe".into());
        unsafe {
            if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                let mut ok = Process32FirstW(snap, &mut entry).is_ok();
                while ok {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                    if exe == name && entry.th32ProcessID != me {
                        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, entry.th32ProcessID) {
                            let _ = TerminateProcess(h, 1);
                            let _ = CloseHandle(h);
                            log!("ended process {}", entry.th32ProcessID);
                        }
                    }
                    ok = Process32NextW(snap, &mut entry).is_ok();
                }
                let _ = CloseHandle(snap);
            }
        }
        std::thread::sleep(Duration::from_millis(300));
        crate::taskband::restore();
        restore_now();
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
        if read_journal().is_some() {
            log!("watchdog: the dock (pid {pid}) ended without restoring the taskbar");
        }
        crate::fps::shutdown();
        crate::taskband::restore();
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

    /// Asks Explorer for a taskbar state. Always sent: Explorer applies a
    /// change with a delay, so the state it reports can be out of date.
    fn set_taskbar_state(state: u32) {
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

    /// Sets the state and waits until Explorer reports it, asking again now
    /// and then. False when it didn't take within `wait`.
    fn apply_taskbar_state(state: u32, wait: Duration) -> bool {
        let start = Instant::now();
        let mut sent: Option<Instant> = None;
        loop {
            if sent.map_or(true, |t| t.elapsed() >= Duration::from_millis(500)) {
                set_taskbar_state(state);
                sent = Some(Instant::now());
            }
            std::thread::sleep(Duration::from_millis(50));
            if get_taskbar_state() == state {
                return true;
            }
            if start.elapsed() >= wait {
                return false;
            }
        }
    }

    fn show_native(show: bool) {
        show_taskbars(show, true);
    }

    /// Shows or hides the main taskbar and, with `secondary`, the taskbars
    /// of the other screens; without, those are shown.
    fn show_taskbars(show: bool, secondary: bool) {
        let set = |hwnd: HWND, show: bool| unsafe {
            if IsWindowVisible(hwnd).as_bool() != show {
                let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        };
        if let Some(t) = taskbar() {
            set(t, show);
        }
        for t in secondary_taskbars() {
            set(t, show || !secondary);
        }
    }

    fn start_replacing() -> Result<(), String> {
        if taskbar().is_none() {
            return Err("The Windows taskbar can't be found (Explorer may be restarting).".into());
        }
        let known = ORIGINAL.lock().ok().and_then(|o| *o);
        let original = match read_journal() {
            Some(state) => state,
            None => {
                let state = known.unwrap_or_else(get_taskbar_state);
                write_journal(state).map_err(|e| format!("The taskbar was left alone: its recovery file can't be written ({e})."))?;
                log!("taking the taskbar's place (its state was {state})");
                state
            }
        };
        if let Ok(mut o) = ORIGINAL.lock() {
            o.get_or_insert(original);
        }
        // Auto-hide makes Explorer give back the space it keeps for the
        // taskbar; hiding it keeps it from sliding in.
        set_taskbar_state(ABS_AUTOHIDE | (original & ABS_ALWAYSONTOP));
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

    fn appbar_registered(hwnd: HWND) -> bool {
        APPBARS
            .lock()
            .map(|a| a.as_ref().is_some_and(|a| a.contains(&(hwnd.0 as isize))))
            .unwrap_or(false)
    }

    fn appbar_send_remove(hwnd: HWND) {
        let mut data = appbar_data(hwnd, ABE_BOTTOM, RECT::default());
        unsafe {
            SHAppBarMessage(ABM_REMOVE, &mut data);
        }
    }

    fn appbar_remove(hwnd: HWND) {
        let was = APPBARS
            .lock()
            .map(|mut a| a.as_mut().is_some_and(|a| a.remove(&(hwnd.0 as isize))))
            .unwrap_or(false);
        if was {
            appbar_send_remove(hwnd);
        }
    }

    /// Claims `size` physical pixels along the edge of `monitor` and returns
    /// the rectangle Windows gave the dock (it may sit above another app bar).
    fn appbar_set(hwnd: HWND, monitor: RECT, top: bool, size: i32) -> RECT {
        let edge = if top { ABE_TOP } else { ABE_BOTTOM };
        if !appbar_registered(hwnd) {
            let mut data = appbar_data(hwnd, edge, RECT::default());
            if unsafe { SHAppBarMessage(ABM_NEW, &mut data) } != 0 {
                if let Ok(mut a) = APPBARS.lock() {
                    a.get_or_insert_with(HashSet::new).insert(hwnd.0 as isize);
                }
            } else {
                log!("app bar registration failed");
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

    /// A screen, and the label of the dock that belongs on it.
    struct Screen {
        label: String,
        rect: RECT,
        scale: f64,
    }

    /// Every screen, the primary one first.
    fn screens() -> Vec<Screen> {
        unsafe extern "system" fn each(m: HMONITOR, _dc: HDC, _rc: *mut RECT, lparam: LPARAM) -> BOOL {
            let list = &mut *(lparam.0 as *mut Vec<HMONITOR>);
            list.push(m);
            BOOL(1)
        }
        let mut handles: Vec<HMONITOR> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut handles as *mut _ as isize));
        }
        let mut list: Vec<(bool, Screen)> = handles
            .into_iter()
            .filter_map(|m| unsafe {
                let mut info = MONITORINFOEXW::default();
                info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                if !GetMonitorInfoW(m, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
                    return None;
                }
                // MONITORINFOF_PRIMARY
                let primary = info.monitorInfo.dwFlags & 1 != 0;
                let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
                let device: String = String::from_utf16_lossy(&info.szDevice[..len])
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect::<String>()
                    .to_lowercase();
                let (mut dx, mut dy) = (96u32, 96u32);
                let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
                Some((
                    primary,
                    Screen {
                        label: if primary { DOCK.to_string() } else { format!("dock-{device}") },
                        rect: info.monitorInfo.rcMonitor,
                        scale: dx.max(96) as f64 / 96.0,
                    },
                ))
            })
            .collect();
        list.sort_by_key(|(primary, _)| !*primary);
        list.into_iter().map(|(_, s)| s).collect()
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
        if fg.is_invalid() || own_window(fg) || SHELL_CLASSES.contains(&class_of(fg).as_str()) {
            return false;
        }
        let monitor = unsafe { MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) };
        if monitor_rect(monitor).as_ref() != Some(screen) {
            return false;
        }
        if let Ok(state) = unsafe { SHQueryUserNotificationState() } {
            if [QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE].contains(&state) {
                return true;
            }
        }
        if unsafe { !IsWindowVisible(fg).as_bool() || IsIconic(fg).as_bool() } {
            return false;
        }
        // A maximised window with a title bar spills past the screen by its
        // borders when nothing reserves space; it isn't full screen.
        let style = unsafe { GetWindowLongW(fg, GWL_STYLE) } as u32;
        if unsafe { IsZoomed(fg) }.as_bool() && style & WS_CAPTION.0 == WS_CAPTION.0 {
            return false;
        }
        rect_of(fg).is_some_and(|w| {
            w.left <= screen.left && w.top <= screen.top && w.right >= screen.right && w.bottom >= screen.bottom
        })
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

    #[derive(PartialEq, Clone, Copy, Debug)]
    struct Placement {
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    }

    /// What the loop remembers about one dock window.
    #[derive(Default)]
    struct Dock {
        placed: Option<Placement>,
        /// Where the window was found when it was last moved back.
        drifted: Option<Placement>,
        /// What the app bar was last asked for, and the edge Windows gave.
        reserved: Option<((RECT, bool, i32, bool), i32)>,
        shown: bool,
        grace_until: u64,
        was_full: bool,
        last_state: String,
    }

    /// A dock window for a screen other than the primary one. Same settings
    /// as the primary dock's in `tauri.conf.json`.
    fn create_dock(app: &AppHandle, label: &str) {
        log!("creating dock window {label}");
        let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
            .title("Dynamic Dock")
            .inner_size(1280.0, 600.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .visible(false)
            .build();
        if let Err(e) = built {
            log!("can't create dock window {label}: {e}");
        }
    }

    fn close_dock(window: &WebviewWindow) {
        log!("closing dock window {}", window.label());
        if let Ok(raw) = window.hwnd() {
            appbar_remove(HWND(raw.0 as _));
        }
        forget_page(window.label());
        let _ = window.destroy();
    }

    fn run(app: AppHandle) {
        let mut docks: HashMap<String, Dock> = HashMap::new();
        let mut last_taskbar: Option<isize> = None;
        let mut last_fg = HWND::default();
        let mut error: Option<String> = None;
        let mut ticks: u32 = 0;
        let mut look = (system_light(), accent_colour());
        let mut was_alive: Option<bool> = None;
        let mut last_screens = String::new();

        loop {
            std::thread::sleep(TICK);
            ticks = ticks.wrapping_add(1);
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            let cfg = config::shell();
            let all_screens = cfg.monitors != "primary";
            let mut screens = screens();
            if screens.is_empty() {
                continue;
            }
            if !all_screens {
                screens.truncate(1);
            }
            let summary = screens
                .iter()
                .map(|s| format!("{} {:?} x{}", s.label, (s.rect.left, s.rect.top, s.rect.right, s.rect.bottom), s.scale))
                .collect::<Vec<_>>()
                .join(", ");
            if summary != last_screens {
                log!("screens: {summary}");
                last_screens = summary;
            }

            // One dock per screen: open the missing ones, close the rest.
            let wanted: HashSet<&str> = screens.iter().map(|s| s.label.as_str()).collect();
            for (label, window) in app.webview_windows() {
                if is_dock(&label) && label != DOCK && !wanted.contains(label.as_str()) {
                    close_dock(&window);
                    docks.remove(&label);
                }
            }
            for screen in &screens {
                if screen.label != DOCK && app.get_webview_window(&screen.label).is_none() {
                    create_dock(&app, &screen.label);
                }
            }

            // Explorer restarted: its new taskbar shows, and our app bar
            // registrations went with the old one.
            let tb = taskbar().map(|h| h.0 as isize);
            if tb.is_some() && tb != last_taskbar {
                if last_taskbar.is_some() {
                    log!("Explorer restarted");
                    if let Ok(mut a) = APPBARS.lock() {
                        *a = None;
                    }
                    REPLACED.store(false, Ordering::Relaxed);
                    for d in docks.values_mut() {
                        d.reserved = None;
                    }
                }
                last_taskbar = tb;
            }

            // Replace the taskbar, or give it back. Only while the primary
            // dock page is drawn and no dock page has stopped answering
            // (while a dock is hidden for a full-screen app its timers may
            // sleep, so that doesn't count).
            let mut alive = Some(true);
            for screen in &screens {
                let d = docks.entry(screen.label.clone()).or_default();
                let a = match page_alive(&screen.label, d.grace_until) {
                    Some(false) if !d.shown => Some(true),
                    None if screen.label != DOCK => Some(true),
                    other => other,
                };
                alive = match (alive, a) {
                    (Some(false), _) | (_, Some(false)) => Some(false),
                    (None, _) | (_, None) => None,
                    _ => Some(true),
                };
            }
            if alive != was_alive {
                if alive == Some(false) {
                    log!("a dock page stopped answering; showing the Windows taskbar");
                } else if was_alive == Some(false) {
                    log!("the dock pages answer again");
                }
                was_alive = alive;
            }
            // The dock always takes the taskbar's place; only the tray's "show it
            // for now" and a dock page that isn't running give it back.
            let want = !PAUSED.load(Ordering::Relaxed) && alive == Some(true);
            if want && !REPLACED.load(Ordering::Relaxed) {
                error = start_replacing().err();
                if let Some(e) = &error {
                    log!("can't replace the taskbar: {e}");
                }
            } else if !want && REPLACED.load(Ordering::Relaxed) {
                stop_replacing();
                error = None;
            }
            if want && REPLACED.load(Ordering::Relaxed) {
                // Explorer shows it again now and then (edge hover, Win key).
                // The other screens keep their taskbars when they have no dock.
                show_taskbars(false, all_screens);
            }
            let replaced = REPLACED.load(Ordering::Relaxed);
            let fg = unsafe { GetForegroundWindow() };

            for screen in &screens {
                let Some(window) = app.get_webview_window(&screen.label) else { continue };
                let Ok(raw) = window.hwnd() else { continue };
                let hwnd = HWND(raw.0 as _);
                let d = docks.entry(screen.label.clone()).or_default();

                // Where the bar's outer edge is, in physical pixels.
                let s = screen.scale;
                let reserve = (cfg.reserve() * s).round() as i32;
                let top = cfg.top();
                let edge = if reserve > 0 {
                    // Hiding the taskbar frees its strip, so ask again when
                    // that changes, and every few seconds, since Explorer
                    // applies a new taskbar state with a delay.
                    let key = (screen.rect, top, reserve, replaced);
                    match d.reserved {
                        // Unchanged: no need to ask Windows again.
                        Some((k, edge)) if k == key && appbar_registered(hwnd) && ticks % 15 != 0 => edge,
                        _ => {
                            let rc = appbar_set(hwnd, screen.rect, top, reserve);
                            let edge = if top { rc.top } else { rc.bottom };
                            if d.reserved.map(|r| r.1) != Some(edge) {
                                log!("{}: app bar edge at {edge} (asked for {reserve}px, replaced {replaced})", screen.label);
                            }
                            d.reserved = Some((key, edge));
                            edge
                        }
                    }
                } else {
                    if d.reserved.take().is_some() {
                        appbar_remove(hwnd);
                    }
                    if top {
                        screen.rect.top
                    } else {
                        screen.rect.bottom
                    }
                };

                let h = (cfg.window_height() * s).round() as i32;
                let next = Placement {
                    x: screen.rect.left,
                    y: if top { edge } else { edge - h },
                    w: screen.rect.right - screen.rect.left,
                    h,
                };
                // Check where the window really is, not only what we asked
                // for: moving onto a screen with another scale makes the
                // window library resize and move it on its own.
                let actual = rect_of(hwnd).map(|r| Placement { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });
                if d.placed != Some(next) || actual != Some(next) {
                    let new = d.placed != Some(next) || d.drifted != actual;
                    d.drifted = actual;
                    if new { log!(
                        "{}: window at {},{} size {}x{} (scale {s}, replaced {replaced}, was {:?})",
                        screen.label, next.x, next.y, next.w, next.h,
                        actual.map(|a| (a.x, a.y, a.w, a.h))
                    ); }
                    unsafe {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), next.x, next.y, next.w, next.h, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                    }
                    d.placed = Some(next);
                }

                // Full screen, overlap and topmost.
                let full = cfg.hide_on_fullscreen && fullscreen(fg, &screen.rect);
                let strip_h = ((cfg.bar_height + cfg.margin * 2.0) * s).round() as i32;
                let strip = if top {
                    RECT { top: edge, bottom: edge + strip_h, ..screen.rect }
                } else {
                    RECT { top: edge - strip_h, bottom: edge, ..screen.rect }
                };
                let overlapped = overlaps(fg, &strip);
                if full != d.was_full {
                    log!(
                        "{}: full screen {}: {:?}",
                        screen.label,
                        if full { "on" } else { "off" },
                        if fg.is_invalid() { String::new() } else { class_of(fg) }
                    );
                    d.was_full = full;
                }
                if full == d.shown {
                    // Through Tauri, never a raw ShowWindow: the window
                    // library keeps its own "visible" flag and re-applies it
                    // (hiding the window) on every style change, such as
                    // click-through.
                    let _ = if full { window.hide() } else { window.show() };
                    d.shown = !full;
                    if d.shown {
                        // Give the page time to wake up before judging it.
                        d.grace_until = now_ms() + STALE_AFTER.as_millis() as u64;
                    }
                }
                if d.shown && fg != last_fg {
                    // Something new came to the front; stay above it.
                    unsafe {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
                    }
                }

                // What the dock window really looks like to Windows, logged
                // when it changes, so a dock that "vanished" can be explained.
                let state = unsafe {
                    let r = rect_of(hwnd).unwrap_or_default();
                    let cloaked = {
                        let mut c = 0u32;
                        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut c as *mut u32 as *mut _, 4);
                        c
                    };
                    format!(
                        "visible {} minimised {} cloaked {} rect {},{},{},{}",
                        IsWindowVisible(hwnd).as_bool(),
                        IsIconic(hwnd).as_bool(),
                        cloaked,
                        r.left, r.top, r.right, r.bottom,
                    )
                };
                if state != d.last_state {
                    log!("{}: {state}", screen.label);
                    d.last_state = state;
                }

                // The system look rarely changes: read it every few seconds.
                if ticks % 15 == 0 && screen.label == DOCK {
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
                    let e = e.get_or_insert_with(HashMap::new);
                    if e.get(&screen.label) == Some(&next_env) {
                        false
                    } else {
                        e.insert(screen.label.clone(), next_env.clone());
                        true
                    }
                });
                if changed.unwrap_or(false) {
                    let _ = app.emit_to(screen.label.as_str(), ENV_EVENT, next_env);
                }
            }
            last_fg = fg;
        }
    }
}
