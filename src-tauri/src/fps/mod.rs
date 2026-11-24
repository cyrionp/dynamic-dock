//! FPS counter: frames per second, measured once a second, shown on the
//! dock and, on request, in a small window over a game.
//!
//! Nothing is injected into the game and nothing hooks it, so anti-cheat
//! has nothing to see and the game runs as before:
//!
//! - **Per game** the frames come from Windows' own event tracing (ETW):
//!   DXGI and Direct3D 9 write an event for every frame an app presents
//!   (`Present_Start`), which is what PresentMon and the Xbox Game Bar's
//!   counter read too. Only those events are switched on, filtered by id in
//!   Windows itself, and the dock counts the ones from the app in front.
//!   Starting such a session needs an administrator or a member of the
//!   *Performance Log Users* group (see [`enable_game_capture`]).
//! - **Otherwise** (no permission, or the app in front presents some other
//!   way) the counter falls back to the frames the desktop compositor (DWM)
//!   puts on the screen: the screen's refresh, close to the game's frame
//!   rate in a window or borderless, but capped by the monitor.
//!
//! The measuring thread and the trace session only exist while the counter
//! runs; stopping it ends both and sets the count back to zero.

mod overlay;

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Sent to every window whenever the counter's state changes.
pub const FPS_EVENT: &str = "fps://state";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FpsState {
    /// The counter is measuring.
    pub running: bool,
    /// Frames in the last second; 0 while stopped.
    pub fps: u32,
    /// "game": the app in front, counted from its own frames; "screen":
    /// frames the desktop showed; "" while stopped or before the first
    /// second.
    pub source: String,
    /// The app in front (its file name), for "game".
    pub app: String,
    /// The counter is shown over the screen.
    pub overlay: bool,
    /// The overlay can be dragged (and takes clicks) right now.
    pub moving: bool,
    /// Whether per-game measuring could start; `None` until it was tried.
    pub game_capture: Option<bool>,
    /// This build can measure at all (Windows only).
    pub supported: bool,
}

static STATE: Mutex<Option<FpsState>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();
/// Bumped on every start and stop; a measuring thread from an older one
/// ends itself.
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    // A session left over by a dock that was killed while measuring.
    imp::stop_stale_session();
}

fn with_state<R>(f: impl FnOnce(&mut FpsState) -> R) -> R {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(|| FpsState {
        supported: cfg!(windows),
        ..Default::default()
    });
    f(state)
}

/// Changes the state and tells every window and the overlay.
fn publish(f: impl FnOnce(&mut FpsState)) {
    let state = with_state(|s| {
        f(s);
        s.clone()
    });
    overlay::update(state.fps);
    if let Some(app) = APP.get() {
        let _ = app.emit(FPS_EVENT, state);
    }
}

pub fn snapshot() -> FpsState {
    with_state(|s| s.clone())
}

pub fn set_running(on: bool) {
    if on {
        start();
    } else {
        stop();
    }
}

pub fn toggle() {
    set_running(!snapshot().running);
}

fn start() {
    if !cfg!(windows) {
        return;
    }
    let generation = with_state(|s| {
        if s.running {
            return None;
        }
        s.running = true;
        s.fps = 0;
        s.source.clear();
        s.app.clear();
        Some(GENERATION.fetch_add(1, Ordering::SeqCst) + 1)
    });
    let Some(generation) = generation else { return };
    publish(|_| {});
    let spawned = std::thread::Builder::new()
        .name("fps".into())
        .spawn(move || measure(generation));
    if spawned.is_err() {
        stop();
    }
}

/// Stops measuring, sets the count back to zero and hides the overlay.
fn stop() {
    let was_running = with_state(|s| std::mem::replace(&mut s.running, false));
    if !was_running {
        return;
    }
    GENERATION.fetch_add(1, Ordering::SeqCst);
    overlay::hide();
    publish(|s| {
        s.fps = 0;
        s.source.clear();
        s.app.clear();
        s.overlay = false;
        s.moving = false;
    });
}

/// Shows or hides the counter over the screen. Showing it starts the
/// counter if it isn't running.
pub fn set_overlay(on: bool) {
    if !cfg!(windows) {
        return;
    }
    if on {
        start();
        overlay::show();
        publish(|s| s.overlay = true);
    } else {
        overlay::hide();
        publish(|s| {
            s.overlay = false;
            s.moving = false;
        });
    }
}

pub fn toggle_overlay() {
    set_overlay(!snapshot().overlay);
}

/// While moving, the overlay takes the pointer and can be dragged; after,
/// clicks go through it again.
pub fn set_moving(on: bool) {
    if on && !snapshot().overlay {
        set_overlay(true);
    }
    overlay::set_moving(on);
    publish(|s| s.moving = on && s.overlay);
}

/// The dock is quitting.
pub fn shutdown() {
    stop();
    imp::stop_stale_session();
}

/// The measuring thread: one reading a second until the generation moves on.
fn measure(generation: u64) {
    let current = || GENERATION.load(Ordering::SeqCst) == generation;
    let mut meter = imp::Meter::new();
    if !current() {
        return;
    }
    let capture = meter.game_capture();
    publish(|s| s.game_capture = Some(capture));
    loop {
        // Short naps, so a stop ends the thread (and the trace) quickly.
        let until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < until {
            if !current() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let reading = meter.read();
        if !current() {
            return;
        }
        publish(|s| {
            s.fps = reading.fps;
            s.source = reading.source.into();
            s.app = reading.app;
        });
    }
}

/// One second's measurement.
pub struct Reading {
    pub fps: u32,
    pub source: &'static str,
    pub app: String,
}

/// Asks once (with the Windows administrator prompt) to add the user to
/// the *Performance Log Users* group, which lets the dock read the games'
/// frame events without running as administrator. Applies from the next
/// sign-in.
pub fn enable_game_capture() -> Result<(), String> {
    imp::enable_game_capture()
}

#[cfg(not(windows))]
mod imp {
    use super::Reading;

    pub struct Meter;
    impl Meter {
        pub fn new() -> Self {
            Meter
        }
        pub fn game_capture(&self) -> bool {
            false
        }
        pub fn read(&mut self) -> Reading {
            Reading { fps: 0, source: "", app: String::new() }
        }
    }

    pub fn stop_stale_session() {}

    pub fn enable_game_capture() -> Result<(), String> {
        Err("Windows only".into())
    }
}

#[cfg(windows)]
mod etw;

#[cfg(windows)]
mod imp {
    use super::{etw, Reading};
    use std::collections::HashMap;
    use std::time::Instant;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::Graphics::Dwm::{DwmGetCompositionTimingInfo, DWM_TIMING_INFO};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SW_HIDE};

    pub use etw::stop_stale_session;

    pub struct Meter {
        etw: Option<etw::Session>,
        last: Instant,
        last_frame: Option<u64>,
        foreground: u32,
        /// When the app in front last changed.
        since: Instant,
        names: HashMap<u32, String>,
    }

    impl Meter {
        pub fn new() -> Self {
            let etw = match etw::Session::start() {
                Ok(s) => Some(s),
                Err(code) => {
                    crate::log::write(&format!("fps: per-game counting unavailable (error {code}), using the screen's frames"));
                    None
                }
            };
            Meter {
                etw,
                last: Instant::now(),
                last_frame: dwm_frames(),
                foreground: 0,
                since: Instant::now(),
                names: HashMap::new(),
            }
        }

        pub fn game_capture(&self) -> bool {
            self.etw.is_some()
        }

        pub fn read(&mut self) -> Reading {
            let now = Instant::now();
            let secs = now.duration_since(self.last).as_secs_f64().max(0.001);
            self.last = now;

            let foreground = foreground_pid();
            if foreground != self.foreground {
                self.foreground = foreground;
                self.since = now;
                etw::watch_process(foreground);
            }
            // A full second of the app's frames is known 1.2 s after it
            // came to the front (see `frames_last_second`).
            let settled = now.duration_since(self.since).as_millis() >= 1300;
            let frames = match &self.etw {
                Some(_) if settled => etw::frames_last_second(),
                _ => 0,
            };

            let frame = dwm_frames();
            let screen = match (self.last_frame, frame) {
                (Some(a), Some(b)) => (b.saturating_sub(a) as f64 / secs).round() as u32,
                _ => 0,
            };
            self.last_frame = frame;

            // An app that draws its own frames (a game) is counted itself;
            // anything else, or right after a switch, by the screen.
            if frames > 0 {
                let app = self.name(foreground);
                return Reading { fps: frames, source: "game", app };
            }
            Reading { fps: screen, source: "screen", app: String::new() }
        }

        fn name(&mut self, pid: u32) -> String {
            if self.names.len() > 64 {
                self.names.clear();
            }
            self.names.entry(pid).or_insert_with(|| process_name(pid)).clone()
        }
    }

    fn foreground_pid() -> u32 {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.is_invalid() {
                return 0;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            pid
        }
    }

    fn process_name(pid: u32) -> String {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(handle);
            if !ok {
                return String::new();
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
        }
    }

    /// Frames the desktop compositor has made so far.
    fn dwm_frames() -> Option<u64> {
        let mut info = DWM_TIMING_INFO {
            cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
            ..Default::default()
        };
        unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) }.ok()?;
        Some(info.cFrame)
    }

    pub fn enable_game_capture() -> Result<(), String> {
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(d), Ok(u)) if !d.is_empty() => format!("{d}\\{u}"),
            (_, Ok(u)) => u,
            _ => return Err("unknown user".into()),
        };
        // S-1-5-32-559 is "Performance Log Users" in every Windows language.
        let member = user.replace('\'', "''");
        let args = format!(
            "-NoProfile -NonInteractive -WindowStyle Hidden -Command \"Add-LocalGroupMember -SID 'S-1-5-32-559' -Member '{member}' -ErrorAction SilentlyContinue\""
        );
        let result = unsafe {
            ShellExecuteW(
                None,
                &HSTRING::from("runas"),
                &HSTRING::from("powershell.exe"),
                &HSTRING::from(args),
                PCWSTR::null(),
                SW_HIDE,
            )
        };
        if result.0 as isize > 32 {
            crate::log::write("fps: asked to join Performance Log Users");
            Ok(())
        } else {
            Err("cancelled".into())
        }
    }
}
