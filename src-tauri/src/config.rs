//! The user's settings, kept as one JSON file in the app's config folder.
//!
//! The frontend owns the shape of the file (defaults, validation and every
//! option live in `src/lib/config.js`); Rust stores it, hands it to every
//! window, and reads the few fields it needs itself: where the dock goes,
//! how tall it is, whether it replaces the taskbar, auto-hide and hotkeys.

use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Sent to every window after the settings changed.
pub const CHANGED_EVENT: &str = "config://changed";

/// What Rust itself needs from the settings. Missing fields fall back to
/// the same defaults the frontend uses.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Shell {
    /// "all" screens or the "primary" one only.
    pub monitors: String,
    /// "bottom" or "top".
    pub position: String,
    /// The bar's height in CSS pixels.
    pub bar_height: f64,
    /// Gap between the bar and the screen edge, in CSS pixels.
    pub margin: f64,
    /// "off", "smart" (hide while a window covers it) or "always".
    pub auto_hide: String,
    /// Step aside for full-screen games and videos.
    pub hide_on_fullscreen: bool,
    /// Room above the bar for pop-ups and magnified icons, in CSS pixels.
    pub popup_space: f64,
}

impl Default for Shell {
    fn default() -> Self {
        Self {
            monitors: "all".into(),
            position: "bottom".into(),
            bar_height: 52.0,
            margin: 6.0,
            auto_hide: "off".into(),
            hide_on_fullscreen: true,
            popup_space: 520.0,
        }
    }
}

impl Shell {
    pub fn top(&self) -> bool {
        self.position == "top"
    }

    /// How much of the screen edge the dock keeps for itself, in CSS
    /// pixels. Nothing while it hides itself.
    pub fn reserve(&self) -> f64 {
        if self.auto_hide == "off" {
            self.bar_height + self.margin * 2.0
        } else {
            0.0
        }
    }

    /// The dock window's height: the bar plus room for pop-ups.
    pub fn window_height(&self) -> f64 {
        self.bar_height + self.margin * 2.0 + self.popup_space
    }
}

/// Hotkeys, as accelerator strings ("Ctrl+Alt+Right"). Empty: none.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hotkeys {
    pub next_bar: String,
    pub previous_bar: String,
    pub bar1: String,
    pub bar2: String,
    pub bar3: String,
    pub toggle_dock: String,
    pub toggle_cat: String,
    /// Start or stop the FPS counter.
    pub toggle_fps: String,
    /// Show or hide the FPS counter over the screen.
    pub toggle_fps_overlay: String,
    /// Open or close Dynamic Launcher.
    pub open_launcher: String,
}

struct Store {
    value: Value,
    path: Option<PathBuf>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| {
        Mutex::new(Store {
            value: Value::Null,
            path: None,
        })
    })
}

/// Reads the settings file once at start-up.
pub fn load(app: &AppHandle) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"));
    let value = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    if let Ok(mut s) = store().lock() {
        s.value = value;
        s.path = path;
    }
}

/// The whole settings object, or `null` before the first save.
pub fn get() -> Value {
    store().lock().map(|s| s.value.clone()).unwrap_or(Value::Null)
}

/// Replaces the settings, writes them to disk (atomically) and tells every
/// window.
pub fn set(app: &AppHandle, value: Value) -> Result<(), String> {
    let path = {
        let mut s = store().lock().map_err(|e| e.to_string())?;
        s.value = value.clone();
        s.path.clone()
    };
    if let Some(path) = path {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    let _ = app.emit(CHANGED_EVENT, value);
    Ok(())
}

pub(crate) fn section<T: for<'de> Deserialize<'de> + Default>(key: &str) -> T {
    store()
        .lock()
        .ok()
        .and_then(|s| s.value.get(key).cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The bits of `look` that change where the dock goes.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Look {
    style: String,
}

pub fn shell() -> Shell {
    let mut shell: Shell = section("shell");
    // The full width bar sits right on the screen edge, so the distance from
    // the edge doesn't apply: keeping it would leave an empty strip above
    // the bar that windows can't use.
    if section::<Look>("look").style == "full" {
        shell.margin = 0.0;
    }
    shell
}

pub fn hotkeys() -> Hotkeys {
    section("hotkeys")
}
