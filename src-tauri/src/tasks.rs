//! The open windows the dock shows, and acting on them.
//!
//! A worker thread listens to window events (created, destroyed, shown,
//! hidden, renamed, minimised, brought to the front) through
//! `SetWinEventHook`. After a burst of events it lists the windows again,
//! and also every couple of seconds, because some apps (WhatsApp, for one)
//! make their window a taskbar window by changing its style, which sends no
//! event. It sends `tasks://update` only when the list really changed.
//!
//! Which windows count follows the taskbar's own rules: visible, not
//! cloaked (other virtual desktops, suspended Store apps), not owned by
//! another window unless marked as an app window, and not a tool window.

use serde::Serialize;

pub const TASKS_EVENT: &str = "tasks://update";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWindow {
    /// The window handle, passed back to `task_action`.
    pub hwnd: i64,
    pub title: String,
    /// Full path of the program.
    pub exe: String,
    /// What groups windows into one app: the AppUserModelID when the window
    /// has one, otherwise the program's path (lower case).
    pub app_id: String,
    /// Key for `get_icons`.
    pub icon: String,
    pub minimized: bool,
    pub active: bool,
}

#[cfg(windows)]
pub use imp::{act, init, snapshot};
#[cfg(windows)]
pub(crate) use imp::exe_of_pid;

#[cfg(not(windows))]
mod fallback {
    use super::TaskWindow;
    pub fn init(_app: &tauri::AppHandle) {}
    pub fn snapshot() -> Vec<TaskWindow> {
        Vec::new()
    }
    pub fn act(_hwnd: i64, _action: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
}

#[cfg(not(windows))]
pub use fallback::{act, init, snapshot};

#[cfg(windows)]
mod imp {
    use super::{TaskWindow, TASKS_EVENT};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, DispatchMessageW, EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW,
        GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, MsgWaitForMultipleObjects,
        PeekMessageW, PostMessageW, SetForegroundWindow, ShowWindow, SwitchToThisWindow, TranslateMessage,
        EVENT_OBJECT_CLOAKED, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
        EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GA_ROOT, GWL_EXSTYLE, GW_OWNER, MSG,
        OBJID_WINDOW, PM_REMOVE, QS_ALLINPUT, SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, SW_RESTORE,
        WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_SYSCOMMAND, WS_EX_APPWINDOW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    /// Quiet time after the last event before the list is read again.
    const SETTLE: Duration = Duration::from_millis(50);
    /// During a steady stream of events, read at least this often.
    const MAX_WAIT: Duration = Duration::from_millis(250);
    /// With no events at all, still read the list this often.
    const RESCAN: Duration = Duration::from_secs(2);

    static DIRTY: AtomicBool = AtomicBool::new(false);
    static LIST: Mutex<Vec<TaskWindow>> = Mutex::new(Vec::new());

    pub fn snapshot() -> Vec<TaskWindow> {
        LIST.lock().map(|l| l.clone()).unwrap_or_default()
    }

    pub fn init(app: &AppHandle) {
        let app = app.clone();
        std::thread::Builder::new()
            .name("tasks".into())
            .spawn(move || run(app))
            .ok();
    }

    unsafe extern "system" fn on_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event == EVENT_SYSTEM_FOREGROUND || (id_object == OBJID_WINDOW.0 && id_child == 0 && !hwnd.is_invalid()) {
            // Only top-level windows matter (and the foreground switch).
            if event == EVENT_SYSTEM_FOREGROUND || event == EVENT_OBJECT_DESTROY || GetAncestor(hwnd, GA_ROOT) == hwnd {
                DIRTY.store(true, Ordering::Relaxed);
            }
        }
    }

    fn run(app: AppHandle) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            let ranges = [
                (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
                (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
                (EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE),
                (EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE),
                (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
            ];
            for (min, max) in ranges {
                SetWinEventHook(min, max, None, Some(on_event), 0, 0, flags);
            }
        }

        let mut order: HashMap<isize, u64> = HashMap::new();
        let mut next_order: u64 = 0;
        let mut exe_cache: HashMap<u32, (String, Option<String>)> = HashMap::new();
        // When the first unhandled event came in, and the latest one.
        let mut dirty_since: Option<Instant> = Some(Instant::now());
        let mut last_event = Instant::now();
        let mut last_read = Instant::now();

        loop {
            let timeout = if dirty_since.is_some() {
                SETTLE.as_millis() as u32
            } else {
                RESCAN.saturating_sub(last_read.elapsed()).as_millis() as u32
            };
            unsafe {
                MsgWaitForMultipleObjects(None, false, timeout, QS_ALLINPUT);
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            if DIRTY.swap(false, Ordering::Relaxed) {
                last_event = Instant::now();
                dirty_since.get_or_insert(last_event);
            }
            if let Some(since) = dirty_since {
                // Let a burst of events settle, but don't wait forever.
                if last_event.elapsed() < SETTLE && since.elapsed() < MAX_WAIT {
                    continue;
                }
            } else if last_read.elapsed() < RESCAN {
                continue;
            }
            dirty_since = None;
            last_read = Instant::now();

            let list = read_windows(&mut order, &mut next_order, &mut exe_cache);
            let changed = LIST.lock().map(|mut l| {
                if *l == list {
                    false
                } else {
                    *l = list.clone();
                    true
                }
            });
            if changed.unwrap_or(false) {
                let _ = app.emit(TASKS_EVENT, list);
            }
        }
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn title_of(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid
    }

    pub(crate) fn exe_of_pid(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
            let _ = CloseHandle(handle);
            ok.ok()?;
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        }
    }

    /// A packaged app's id (WhatsApp, Store apps), from its process, for
    /// windows that don't carry one themselves. None for ordinary programs.
    fn aumid_of_pid(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let err = GetApplicationUserModelId(handle, &mut len, Some(PWSTR(buf.as_mut_ptr())));
            let _ = CloseHandle(handle);
            if err.0 != 0 || len == 0 {
                return None;
            }
            // `len` counts the closing zero.
            let text = String::from_utf16_lossy(&buf[..(len as usize - 1).min(buf.len())]);
            (!text.is_empty()).then_some(text)
        }
    }

    fn cloaked(hwnd: HWND) -> bool {
        let mut value = 0u32;
        unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut value as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32)
                .is_ok()
                && value != 0
        }
    }

    /// The taskbar's rules for which windows get a button.
    fn counts(hwnd: HWND, own_pid: u32) -> bool {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || cloaked(hwnd) {
                return false;
            }
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let app_window = ex & WS_EX_APPWINDOW.0 != 0;
            if !app_window {
                if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 {
                    return false;
                }
                if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                    return false;
                }
            }
            if pid_of(hwnd) == own_pid || GetWindowTextLengthW(hwnd) == 0 {
                return false;
            }
        }
        !matches!(
            class_of(hwnd).as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Windows.UI.Core.CoreWindow"
        )
    }

    fn app_user_model_id(hwnd: HWND) -> Option<String> {
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
            let value = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
            let text = value.to_string();
            (!text.is_empty()).then_some(text)
        }
    }

    /// A Store app's window belongs to ApplicationFrameHost; the app itself
    /// runs in a child window of another process.
    fn store_app_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
        unsafe extern "system" fn each(child: HWND, lparam: LPARAM) -> BOOL {
            let found = &mut *(lparam.0 as *mut (u32, u32));
            let pid = pid_of(child);
            if pid != found.0 && class_of(child) == "Windows.UI.Core.CoreWindow" {
                found.1 = pid;
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut found = (frame_pid, 0u32);
        unsafe {
            let _ = EnumChildWindows(Some(frame), Some(each), LPARAM(&mut found as *mut _ as isize));
        }
        (found.1 != 0).then_some(found.1)
    }

    fn read_windows(
        order: &mut HashMap<isize, u64>,
        next: &mut u64,
        exe_cache: &mut HashMap<u32, (String, Option<String>)>,
    ) -> Vec<TaskWindow> {
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let list = &mut *(lparam.0 as *mut Vec<HWND>);
            list.push(hwnd);
            BOOL(1)
        }
        let mut all: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut all as *mut _ as isize));
        }
        let own = std::process::id();
        let fg = unsafe { GetForegroundWindow() };
        let mut alive = std::collections::HashSet::new();
        let mut out = Vec::new();
        for hwnd in all {
            if !counts(hwnd, own) {
                continue;
            }
            let key = hwnd.0 as isize;
            alive.insert(key);
            let mut pid = pid_of(hwnd);
            let frame = class_of(hwnd) == "ApplicationFrameWindow";
            if frame {
                if let Some(real) = store_app_pid(hwnd, pid) {
                    pid = real;
                }
            }
            let (exe, process_aumid) = exe_cache
                .entry(pid)
                .or_insert_with(|| (exe_of_pid(pid).unwrap_or_default(), aumid_of_pid(pid)))
                .clone();
            // The window's own id first, then its package's, so a packaged
            // app groups and matches its pin (taken from the Windows
            // taskbar by that id) and shows its real icon.
            let aumid = app_user_model_id(hwnd).or_else(|| process_aumid.clone());
            let packaged = frame || process_aumid.is_some() || exe.to_ascii_lowercase().contains("\\windowsapps\\");
            let icon = match (&aumid, packaged) {
                (Some(id), true) => format!("shell:AppsFolder\\{id}"),
                _ => exe.clone(),
            };
            let app_id = aumid.clone().unwrap_or_else(|| exe.to_lowercase());
            let seq = *order.entry(key).or_insert_with(|| {
                *next += 1;
                *next
            });
            out.push((
                seq,
                TaskWindow {
                    hwnd: key as i64,
                    title: title_of(hwnd),
                    exe,
                    app_id,
                    icon,
                    minimized: unsafe { IsIconic(hwnd).as_bool() },
                    active: hwnd == fg,
                },
            ));
        }
        order.retain(|k, _| alive.contains(k));
        // Processes come and go; keep the cache small.
        if exe_cache.len() > 512 {
            exe_cache.clear();
        }
        out.sort_by_key(|(seq, _)| *seq);
        out.into_iter().map(|(_, w)| w).collect()
    }

    fn bring_to_front(hwnd: HWND) {
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if SetForegroundWindow(hwnd).as_bool() {
                return;
            }
            // Borrow the foreground thread's input state for a moment, the
            // usual way around the foreground lock.
            let fg = GetForegroundWindow();
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let me = GetCurrentThreadId();
            let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            if attached {
                let _ = AttachThreadInput(me, fg_thread, false);
            }
            if GetForegroundWindow() != hwnd {
                SwitchToThisWindow(hwnd, true);
            }
        }
    }

    fn syscommand(hwnd: HWND, cmd: u32) {
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(cmd as usize), LPARAM(0));
        }
    }

    /// `activate` brings the window forward, or minimises it when it already
    /// is in front, like a taskbar button.
    pub fn act(hwnd: i64, action: &str) -> Result<(), String> {
        let hwnd = HWND(hwnd as isize as _);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return Err("That window is gone".into());
            }
        }
        match action {
            "activate" => unsafe {
                if GetForegroundWindow() == hwnd && !IsIconic(hwnd).as_bool() {
                    syscommand(hwnd, SC_MINIMIZE);
                } else {
                    bring_to_front(hwnd);
                }
            },
            "focus" => bring_to_front(hwnd),
            "minimize" => syscommand(hwnd, SC_MINIMIZE),
            "maximize" => unsafe {
                syscommand(hwnd, if IsZoomed(hwnd).as_bool() { SC_RESTORE } else { SC_MAXIMIZE });
            },
            "restore" => syscommand(hwnd, SC_RESTORE),
            "close" => syscommand(hwnd, SC_CLOSE),
            other => return Err(format!("Unknown window action: {other}")),
        }
        DIRTY.store(true, Ordering::Relaxed);
        Ok(())
    }
}
