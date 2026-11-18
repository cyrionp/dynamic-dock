//! Overlay badges that apps put on their taskbar button (WhatsApp, Teams,
//! Discord, Outlook… show their unread count this way).
//!
//! Apps call `ITaskbarList3::SetOverlayIcon`; Windows hands the call to the
//! window named by the taskbar's `TaskbandHWND` property, normally a window
//! of Explorer's (hidden) taskbar. While the dock runs, that property points
//! at a hidden window of ours instead, which turns the calls into
//! `taskband://overlays` events: window handle → the badge as a PNG `data:`
//! URL. Explorer's own window is written to a file first, and put back when
//! the dock stops, crashes (the watchdog) or the taskbar is restored by hand.

use std::collections::BTreeMap;

pub const OVERLAYS_EVENT: &str = "taskband://overlays";

/// Window handle (as text) → overlay picture.
pub type Overlays = BTreeMap<String, String>;

#[cfg(windows)]
pub use imp::{init, restore, snapshot};

#[cfg(not(windows))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn restore() {}

#[cfg(not(windows))]
pub fn snapshot() -> Overlays {
    Overlays::new()
}

#[cfg(windows)]
mod imp {
    use super::{Overlays, OVERLAYS_EVENT};
    use crate::log::log;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};
    use windows::core::BOOL;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CopyIcon, CreateWindowExW, DefWindowProcW, DestroyIcon, DispatchMessageW, EnumWindows, FindWindowExW,
        FindWindowW, GetMessageW, GetPropW, GetWindow, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
        RegisterClassW, RegisterWindowMessageW, RemovePropW, SendNotifyMessageW, SetPropW, SetTimer, TranslateMessage,
        GW_OWNER, HICON, MSG, WINDOW_EX_STYLE, WM_TIMER, WM_USER, WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    /// ITaskbarList messages, as Explorer's task band receives them.
    const SET_OVERLAY_ICON: u32 = WM_USER + 79;
    /// The rest of ITaskbarList's calls (tabs, progress, thumbnail buttons…):
    /// taken and ignored, as a task band does.
    const TASKBAR_LIST_FIRST: u32 = WM_USER + 50;
    const TASKBAR_LIST_LAST: u32 = WM_USER + 90;

    static OURS: AtomicIsize = AtomicIsize::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static OVERLAYS: Mutex<Overlays> = Mutex::new(Overlays::new());
    /// Overlay calls logged so far; only the first few are, to keep the log short.
    static LOGGED: AtomicU32 = AtomicU32::new(0);

    pub fn snapshot() -> Overlays {
        OVERLAYS.lock().map(|o| o.clone()).unwrap_or_default()
    }

    fn tray() -> Option<HWND> {
        unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok() }.filter(|h| !h.is_invalid())
    }

    fn saved_path() -> Option<PathBuf> {
        crate::log::dir().map(|d| d.join("taskband.txt"))
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    /// Explorer's own task band window: the one saved before we took the
    /// property over, or the classic one inside the tray.
    fn explorers_band(tray: HWND) -> Option<HWND> {
        let saved = saved_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| t.trim().parse::<isize>().ok())
            .map(|v| HWND(v as _))
            .filter(|h| unsafe { IsWindow(Some(*h)).as_bool() } && pid_of(*h) == pid_of(tray));
        saved.or_else(|| unsafe {
            let rebar = FindWindowExW(Some(tray), None, w!("ReBarWindow32"), PCWSTR::null()).ok()?;
            FindWindowExW(Some(rebar), None, w!("MSTaskSwWClass"), PCWSTR::null()).ok()
        })
    }

    /// Tells every taskbar window that its button was (re)made, the way
    /// Explorer does after it restarts. Apps answer by sending their overlay,
    /// progress and thumbnail buttons again, to whichever window now holds
    /// the property.
    fn announce() {
        unsafe extern "system" fn each(hwnd: HWND, msg: LPARAM) -> BOOL {
            unsafe {
                let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
                if IsWindowVisible(hwnd).as_bool() && !owned {
                    let _ = SendNotifyMessageW(hwnd, msg.0 as u32, WPARAM(0), LPARAM(0));
                }
            }
            BOOL(1)
        }
        unsafe {
            let msg = RegisterWindowMessageW(w!("TaskbarButtonCreated"));
            if msg != 0 {
                let _ = EnumWindows(Some(each), LPARAM(msg as isize));
            }
        }
    }

    /// Points the taskbar's `TaskbandHWND` at our window, keeping Explorer's.
    fn take_over(ours: HWND) {
        let Some(tray) = tray() else {
            return;
        };
        unsafe {
            let current = HWND(GetPropW(tray, w!("TaskbandHWND")).0);
            if current == ours {
                return;
            }
            if !current.is_invalid() && pid_of(current) == pid_of(tray) {
                if let Some(path) = saved_path() {
                    let _ = std::fs::write(path, (current.0 as isize).to_string());
                }
            }
            match SetPropW(tray, w!("TaskbandHWND"), Some(HANDLE(ours.0))) {
                Ok(()) => {
                    log!("taking app overlay badges (task band was {:?})", current.0);
                    announce();
                }
                Err(e) => log!("overlay badges: can't take the task band over: {e}"),
            }
        }
    }

    /// Gives the property back to Explorer. Safe from any process.
    pub fn restore() {
        let Some(tray) = tray() else { return };
        unsafe {
            let current = HWND(GetPropW(tray, w!("TaskbandHWND")).0);
            // Only undo our own change.
            if current.is_invalid() || pid_of(current) == pid_of(tray) {
                return;
            }
            match explorers_band(tray) {
                Some(band) => {
                    let _ = SetPropW(tray, w!("TaskbandHWND"), Some(HANDLE(band.0)));
                }
                None => {
                    let _ = RemovePropW(tray, w!("TaskbandHWND"));
                }
            }
            log!("gave app overlay badges back to Explorer");
            // Apps put their badges back on Explorer's buttons.
            announce();
        }
    }

    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        std::thread::Builder::new()
            .name("taskband".into())
            .spawn(|| unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();
                let class = w!("DynamicDockTaskband");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(proc),
                    hInstance: instance.into(),
                    lpszClassName: class,
                    ..Default::default()
                };
                RegisterClassW(&wc);
                let Ok(hwnd) = CreateWindowExW(
                    WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
                    class,
                    w!(""),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                ) else {
                    log!("overlay badges: can't create the task band window");
                    return;
                };
                OURS.store(hwnd.0 as isize, Ordering::SeqCst);
                take_over(hwnd);
                // Explorer restarts with a fresh property: check now and then.
                SetTimer(Some(hwnd), 1, 3000, None);
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            })
            .ok();
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match msg {
            SET_OVERLAY_ICON => {
                let target = wparam.0 as isize;
                // The app may destroy its icon once the call returns: copy it now.
                let picture = if lparam.0 == 0 {
                    None
                } else {
                    CopyIcon(HICON(lparam.0 as _)).ok().and_then(|copy| {
                        let url = crate::icons::icon_data_url(copy);
                        let _ = DestroyIcon(copy);
                        url
                    })
                };
                let unreadable = lparam.0 != 0 && picture.is_none();
                if LOGGED.fetch_add(1, Ordering::Relaxed) < 20 {
                    log!(
                        "overlay badge {} by window {target} (pid {}){}",
                        if lparam.0 == 0 { "cleared" } else { "set" },
                        pid_of(HWND(target as _)),
                        if unreadable { ", but its picture couldn't be read" } else { "" }
                    );
                }
                let changed = OVERLAYS.lock().map(|mut o| {
                    let key = target.to_string();
                    match picture {
                        Some(url) => o.insert(key, url.clone()) != Some(url),
                        None => o.remove(&key).is_some(),
                    }
                });
                if changed.unwrap_or(false) {
                    if let Some(app) = APP.get() {
                        let _ = app.emit(OVERLAYS_EVENT, snapshot());
                    }
                }
                LRESULT(0)
            }
            m if (TASKBAR_LIST_FIRST..=TASKBAR_LIST_LAST).contains(&m) => LRESULT(0),
            WM_TIMER => {
                take_over(hwnd);
                // Forget the badges of windows that are gone.
                let gone = OVERLAYS.lock().map(|mut o| {
                    let before = o.len();
                    o.retain(|k, _| k.parse::<isize>().is_ok_and(|h| IsWindow(Some(HWND(h as _))).as_bool()));
                    before != o.len()
                });
                if gone.unwrap_or(false) {
                    if let Some(app) = APP.get() {
                        let _ = app.emit(OVERLAYS_EVENT, snapshot());
                    }
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}
