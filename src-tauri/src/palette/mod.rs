//! Dynamic Launcher: a search box over everything (Alt+Space).
//!
//! The box is its own small window (`launcher.html`), made once a few
//! seconds after start and then only shown and hidden, so it opens at
//! once. "Keep ready" can be turned off: the window is then made when
//! asked for and closed again afterwards, which frees its memory.
//!
//! All the searching happens here, in Rust: the page sends the typed text
//! and gets back the best few results, already scored and sorted. Sources:
//! Start's apps (re-read in the background when the box opens and the list
//! is a couple of minutes old), the open windows (from `tasks`), Windows
//! settings pages and tools, dock and computer commands (`catalog`), the
//! Shortcuts widget's entries, a calculator (`calc`) and a web search.
//! What the user picks is remembered (`frecency`) and ranks higher next
//! time, especially for the same typed text.
//!
//! Nothing runs while the box is closed: no timers, no polling.

mod calc;
mod catalog;
mod frecency;
mod fuzzy;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{apps, config, fps, log, shell, tasks};
use catalog::{Kind, BUILTINS};
use frecency::History;

pub const LABEL: &str = "launcher";
/// Sent to the launcher page: open (with where to grow from), close, the
/// app list was re-read.
const SHOW_EVENT: &str = "palette://show";
const CLOSE_EVENT: &str = "palette://close";
const INDEX_EVENT: &str = "palette://index";
/// Sent to every window when the hotkey could or couldn't be registered.
pub const STATUS_EVENT: &str = "palette://status";

/// The launcher window, in CSS pixels. The panel inside is narrower and
/// only as tall as its results; the rest is transparent.
const WIDTH: f64 = 760.0;
const HEIGHT: f64 = 580.0;
/// How far down the screen the box sits, as a share of its height.
const TOP: f64 = 0.16;
/// Start's app list is read again when the box opens after this long.
const APPS_STALE: Duration = Duration::from_secs(120);
const MAX_RESULTS: usize = 40;

/* ---------------- settings ---------------- */

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// Keep the window made and hidden, so it opens at once.
    pub keep_ready: bool,
    pub windows: bool,
    pub settings: bool,
    pub commands: bool,
    pub calc: bool,
    pub web: bool,
    pub web_engine: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            keep_ready: true,
            windows: true,
            settings: true,
            commands: true,
            calc: true,
            web: true,
            web_engine: "google".into(),
        }
    }
}

pub fn settings() -> Settings {
    config::section("palette")
}

/* ---------------- results ---------------- */

/// One row in the launcher. The page sends it back as is to run it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hit {
    /// Stable id, for learning: "app:<id>", "win:<app>", "set:<target>"…
    pub key: String,
    /// app, window, setting, command, shortcut, calc, web.
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    /// Key for `get_icons` (a path or `shell:AppsFolder\id`), or empty.
    pub icon: String,
    /// One of the dock's own icons, when there is no picture.
    pub glyph: String,
    pub target: String,
    pub args: String,
    /// The program's path, for "Open file location" and "Run as admin".
    pub path: String,
    /// A window to bring forward (open windows, running apps).
    pub hwnd: i64,
    pub running: bool,
    /// Ask for a second Enter first.
    pub confirm: bool,
    /// "suggested" or "windows" in the empty box's lists.
    pub group: String,
    pub score: i32,
}

/// A searchable thing, with its texts folded once up front.
struct Entry {
    key: String,
    kind: &'static str,
    title: String,
    title_tr: String,
    icon: String,
    glyph: &'static str,
    target: String,
    args: String,
    path: String,
    confirm: bool,
    folded: String,
    folded_tr: String,
    words: String,
    bias: i32,
}

impl Entry {
    fn hit(&self, lang: &str, score: i32) -> Hit {
        let title = if lang == "tr" && !self.title_tr.is_empty() { &self.title_tr } else { &self.title };
        Hit {
            key: self.key.clone(),
            kind: self.kind.to_string(),
            title: title.clone(),
            icon: self.icon.clone(),
            glyph: self.glyph.to_string(),
            target: self.target.clone(),
            args: self.args.clone(),
            path: self.path.clone(),
            confirm: self.confirm,
            score,
            ..Default::default()
        }
    }

    /// How well `q` (folded) matches the names or the extra words.
    fn score(&self, q: &str) -> Option<i32> {
        let mut best = fuzzy::score(q, &self.title, &self.folded);
        if !self.title_tr.is_empty() {
            best = best.max(fuzzy::score(q, &self.title_tr, &self.folded_tr));
        }
        if best.is_none() && q.chars().count() >= 2 && fuzzy::word_start(&self.words, q).is_some() {
            best = Some(380);
        }
        let s = best?;
        // One or two letters: only starts of names and words, or initials,
        // not letters scattered through a long name.
        let n = q.chars().count();
        if (n == 1 && s < 700) || (n == 2 && s < 400) {
            return None;
        }
        Some(s + self.bias)
    }
}

fn entry(key: String, kind: &'static str, title: String, title_tr: String, words: &str) -> Entry {
    Entry {
        folded: fuzzy::fold(&title),
        folded_tr: fuzzy::fold(&title_tr),
        words: fuzzy::fold(words),
        key,
        kind,
        title,
        title_tr,
        icon: String::new(),
        glyph: "",
        target: String::new(),
        args: String::new(),
        path: String::new(),
        confirm: false,
        bias: 0,
    }
}

/* ---------------- state ---------------- */

#[derive(Default)]
struct State {
    apps: Vec<Entry>,
    apps_read: Option<Instant>,
    builtins: Vec<Entry>,
    history: Option<History>,
    history_path: Option<PathBuf>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static LOADING_APPS: AtomicBool = AtomicBool::new(false);

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    let m = STATE.get_or_init(|| Mutex::new(State::default()));
    m.lock().ok().map(|mut s| f(&mut s))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn builtins() -> Vec<Entry> {
    BUILTINS
        .iter()
        .map(|b| {
            let prefix = if b.kind == Kind::Setting { "set" } else { "cmd" };
            let mut e = entry(
                format!("{prefix}:{}{}", b.target, if b.args.is_empty() { String::new() } else { format!(" {}", b.args) }),
                if b.kind == Kind::Setting { "setting" } else { "command" },
                b.en.to_string(),
                b.tr.to_string(),
                b.words,
            );
            e.glyph = b.glyph;
            e.target = b.target.to_string();
            e.args = b.args.to_string();
            e.confirm = b.confirm;
            e
        })
        .collect()
}

/// Reads Start's app list again on a thread of its own, if it is old.
fn refresh_apps(app: &AppHandle, force: bool) {
    let stale = with_state(|s| s.apps_read.map_or(true, |t| t.elapsed() > APPS_STALE)).unwrap_or(true);
    if !(stale || force) || LOADING_APPS.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let list = apps::installed_apps();
        let entries: Vec<Entry> = list
            .into_iter()
            .map(|a| {
                let lower = a.name.to_lowercase();
                let mut e = entry(format!("app:{}", a.id.to_lowercase()), "app", a.name, String::new(), "");
                e.icon = format!("shell:AppsFolder\\{}", a.id);
                e.target = a.id;
                e.path = a.path;
                e.bias = 60;
                // Uninstallers and read-mes clutter Start's list.
                if lower.contains("uninstall") || lower.contains("kaldır") || lower.contains("readme") || lower.contains("release notes") {
                    e.bias = -300;
                }
                e
            })
            .collect();
        let n = entries.len();
        with_state(|s| {
            s.apps = entries;
            s.apps_read = Some(Instant::now());
        });
        LOADING_APPS.store(false, Ordering::SeqCst);
        log::write(&format!("launcher: {n} apps indexed"));
        let _ = app.emit_to(LABEL, INDEX_EVENT, ());
    });
}

/// The Shortcuts widget's entries, from every bar.
fn shortcut_entries() -> Vec<Entry> {
    let cfg = config::get();
    let mut out = Vec::new();
    let Some(bars) = cfg.get("bars").and_then(Value::as_array) else { return out };
    for bar in bars {
        let Some(items) = bar.get("items").and_then(Value::as_object) else { continue };
        for zone in items.values().filter_map(Value::as_array) {
            for item in zone.iter().filter(|i| i.get("type").and_then(Value::as_str) == Some("launcher")) {
                let Some(list) = item.pointer("/opts/entries").and_then(Value::as_array) else { continue };
                for e in list {
                    let target = e.get("target").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    if target.is_empty() {
                        continue;
                    }
                    let name = e.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    let name = if name.is_empty() { base_name(&target) } else { name };
                    let mut x = entry(format!("sc:{}", target.to_lowercase()), "shortcut", name, String::new(), "");
                    x.icon = if target.contains("://") { String::new() } else { target.clone() };
                    x.glyph = if target.contains("://") { "globe" } else { "rocket" };
                    x.args = e.get("args").and_then(Value::as_str).unwrap_or("").to_string();
                    x.path = target.clone();
                    x.target = target;
                    x.bias = 60;
                    out.push(x);
                }
            }
        }
    }
    out
}

fn base_name(path: &str) -> String {
    if let Some((_, rest)) = path.split_once("://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        return host.trim_start_matches("www.").to_string();
    }
    let name = path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if ext.len() <= 4 && !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/* ---------------- searching ---------------- */

/// Open windows by app: app id or program (lower case) → a window.
struct Running {
    windows: Vec<tasks::TaskWindow>,
    by_app: HashMap<String, i64>,
}

fn running() -> Running {
    let windows = tasks::snapshot();
    let mut by_app = HashMap::new();
    for w in &windows {
        by_app.entry(w.app_id.to_lowercase()).or_insert(w.hwnd);
        by_app.entry(w.exe.to_lowercase()).or_insert(w.hwnd);
    }
    Running { windows, by_app }
}

fn mark_running(hit: &mut Hit, run: &Running) {
    if hit.kind != "app" {
        return;
    }
    let id = hit.target.to_lowercase();
    let path = hit.path.to_lowercase();
    let found = run.by_app.get(&id).or_else(|| if path.is_empty() { None } else { run.by_app.get(&path) });
    if let Some(&hwnd) = found {
        hit.running = true;
        hit.hwnd = hwnd;
    }
}

fn window_hit(w: &tasks::TaskWindow) -> Hit {
    Hit {
        key: format!("win:{}", w.app_id.to_lowercase()),
        kind: "window".into(),
        title: if w.title.is_empty() { base_name(&w.exe) } else { w.title.clone() },
        subtitle: base_name(&w.exe),
        icon: w.icon.clone(),
        glyph: "window".into(),
        path: w.exe.clone(),
        hwnd: w.hwnd,
        running: true,
        ..Default::default()
    }
}

fn web_url(engine: &str, q: &str) -> String {
    let enc = encode(q);
    match engine {
        "bing" => format!("https://www.bing.com/search?q={enc}"),
        "duckduckgo" => format!("https://duckduckgo.com/?q={enc}"),
        "yandex" => format!("https://yandex.com.tr/search/?text={enc}"),
        _ => format!("https://www.google.com/search?q={enc}"),
    }
}

/// Percent-encoding for a query string.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The results for `text`, best first. `lang` picks the names shown for
/// built-in entries ("en" or "tr"); both always match.
pub fn query(app: &AppHandle, text: &str, lang: &str) -> Vec<Hit> {
    let started = Instant::now();
    refresh_apps(app, false);
    ensure_history(app);
    let opts = settings();
    let raw = text.trim();
    let run = running();

    // "=2+2" sums only, ">" commands and settings only, "w " open windows
    // only, "?" a web search only.
    let (mode, body) = if let Some(rest) = raw.strip_prefix('=') {
        ("calc", rest.trim())
    } else if let Some(rest) = raw.strip_prefix('>') {
        ("commands", rest.trim())
    } else if let Some(rest) = raw.strip_prefix("w ") {
        ("windows", rest.trim())
    } else if let Some(rest) = raw.strip_prefix('?') {
        ("web", rest.trim())
    } else {
        ("all", raw)
    };
    let q = fuzzy::fold(body);
    let mut hits: Vec<Hit> = Vec::new();

    if q.is_empty() && mode == "all" {
        return suggestions(lang, &opts, &run);
    }

    if opts.calc && (mode == "all" || mode == "calc") {
        let expr = if mode == "calc" { format!("={body}") } else { body.to_string() };
        if let Some(v) = calc::evaluate(&expr) {
            hits.push(Hit {
                key: "calc".into(),
                kind: "calc".into(),
                title: calc::format(v),
                subtitle: body.to_string(),
                glyph: "sparkle".into(),
                score: 5000,
                ..Default::default()
            });
        }
    }

    if mode == "all" || mode == "commands" {
        let now = now();
        with_state(|s| {
            if s.builtins.is_empty() {
                s.builtins = builtins();
            }
            let history = s.history.take().unwrap_or_default();
            let shortcuts = if mode == "all" { shortcut_entries() } else { Vec::new() };
            let apps: &[Entry] = if mode == "all" { &s.apps } else { &[] };
            for e in apps.iter().chain(s.builtins.iter()).chain(shortcuts.iter()) {
                if (e.kind == "setting" && !opts.settings) || (e.kind == "command" && !opts.commands) {
                    continue;
                }
                if let Some(score) = e.score(&q) {
                    let mut h = e.hit(lang, score + history.boost(&e.key, &q, now));
                    mark_running(&mut h, &run);
                    hits.push(h);
                }
            }
            s.history = Some(history);
        });
    }

    if (opts.windows && mode == "all") || mode == "windows" {
        let history = with_state(|s| s.history.take()).flatten().unwrap_or_default();
        let now = now();
        for w in &run.windows {
            let h = window_hit(w);
            let folded_title = fuzzy::fold(&h.title);
            let folded_app = fuzzy::fold(&h.subtitle);
            let s = fuzzy::score(&q, &h.title, &folded_title).max(fuzzy::score(&q, &h.subtitle, &folded_app).map(|s| s - 40));
            let s = if q.is_empty() { Some(500) } else { s };
            if let Some(s) = s {
                let n = q.chars().count();
                if (n == 1 && s < 700) || (n == 2 && s < 400) {
                    continue;
                }
                hits.push(Hit { score: s + 20 + history.boost(&h.key, &q, now), ..h });
            }
        }
        with_state(|s| s.history = Some(history));
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.title.len().cmp(&b.title.len())));
    hits.truncate(MAX_RESULTS);

    if opts.web && !body.is_empty() && (mode == "all" || mode == "web") {
        hits.push(Hit {
            key: "web".into(),
            kind: "web".into(),
            title: body.to_string(),
            subtitle: opts.web_engine.clone(),
            glyph: "globe".into(),
            target: web_url(&opts.web_engine, body),
            ..Default::default()
        });
    }
    let took = started.elapsed();
    if took > Duration::from_millis(30) {
        log::write(&format!("launcher: slow search ({} ms for {:?})", took.as_millis(), raw));
    }
    hits
}

/// The empty box: what was used most lately, then the open windows.
fn suggestions(lang: &str, opts: &Settings, run: &Running) -> Vec<Hit> {
    let now = now();
    let mut hits = Vec::new();
    with_state(|s| {
        if s.builtins.is_empty() {
            s.builtins = builtins();
        }
        let Some(history) = s.history.as_ref() else { return };
        let shortcuts = shortcut_entries();
        for (key, _) in history.top(now, 24) {
            if hits.len() >= 8 {
                break;
            }
            let found = s.apps.iter().chain(s.builtins.iter()).chain(shortcuts.iter()).find(|e| e.key == key);
            if let Some(e) = found {
                let mut h = e.hit(lang, 0);
                h.group = "suggested".into();
                mark_running(&mut h, run);
                hits.push(h);
            }
        }
    });
    if opts.windows {
        for w in run.windows.iter().take(12) {
            hits.push(Hit { group: "windows".into(), ..window_hit(w) });
        }
    }
    hits
}

/* ---------------- running a result ---------------- */

/// Does what a row stands for. `action`: "open" (Enter), "new" (a new
/// window of a running app), "admin", "reveal" (open its folder) or
/// "forget" (drop it from what was learned).
pub fn run(app: &AppHandle, hit: Hit, action: &str, query: &str) -> Result<(), String> {
    ensure_history(app);
    if action == "forget" {
        with_state(|s| {
            if let Some(h) = s.history.as_mut() {
                h.forget(&hit.key);
            }
        });
        save_history();
        return Ok(());
    }
    let result = match (hit.kind.as_str(), action) {
        (_, "reveal") => {
            let path = if hit.path.is_empty() { &hit.target } else { &hit.path };
            if path.is_empty() || path.contains("://") {
                return Err("This has no file to show".into());
            }
            apps::launch("explorer.exe", &format!("/select,\"{path}\""), false)
        }
        ("app", "admin") => {
            if hit.path.to_lowercase().ends_with(".exe") {
                apps::launch(&hit.path, "", true)
            } else {
                apps::launch_app(&hit.target)
            }
        }
        ("app", "open") if hit.running && hit.hwnd != 0 => tasks::act(hit.hwnd, "focus").or_else(|_| apps::launch_app(&hit.target)),
        ("app", _) => apps::launch_app(&hit.target),
        ("window", _) => tasks::act(hit.hwnd, "focus"),
        ("setting", _) | ("shortcut", _) => apps::launch(&hit.target, &hit.args, action == "admin"),
        ("web", _) => apps::launch(&hit.target, "", false),
        ("command", _) => run_command(app, &hit.target),
        ("calc", _) => Ok(()),
        (kind, _) => Err(format!("Unknown result: {kind}")),
    };
    if let Err(e) = &result {
        log::write(&format!("launcher: {} {:?} failed: {e}", hit.kind, hit.title));
    }
    if result.is_ok() && !matches!(hit.kind.as_str(), "calc" | "web") {
        let q = fuzzy::fold(query.trim().trim_start_matches(['>', '=', '?']).trim());
        let now = now();
        with_state(|s| s.history.get_or_insert_with(History::default).record(&hit.key, &q, now));
        save_history();
    }
    result
}

fn run_command(app: &AppHandle, id: &str) -> Result<(), String> {
    let (group, name) = id.split_once(':').unwrap_or(("", id));
    match group {
        "sys" if name == "emptyBin" => apps::empty_recycle_bin(),
        "sys" => apps::power(name),
        "win" => {
            // Let the launcher's window go first, so the keys reach Windows.
            std::thread::sleep(Duration::from_millis(120));
            apps::shortcut(name)
        }
        "dock" => {
            match name {
                "settings" => crate::open_settings_window(app),
                "toggleFps" => fps::toggle(),
                "toggleFpsOverlay" => fps::toggle_overlay(),
                other => {
                    for (label, _) in app.webview_windows() {
                        if shell::is_dock(&label) {
                            let _ = app.emit_to(label.as_str(), "hotkey://action", other);
                        }
                    }
                }
            }
            Ok(())
        }
        _ => Err(format!("Unknown command: {id}")),
    }
}

/// Forgets everything learned (Settings → Launcher).
pub fn forget_all(app: &AppHandle) {
    ensure_history(app);
    with_state(|s| s.history = Some(History::default()));
    save_history();
}

/* ---------------- what it learned, on disk ---------------- */

fn ensure_history(app: &AppHandle) {
    let loaded = with_state(|s| s.history.is_some()).unwrap_or(true);
    if loaded {
        return;
    }
    let path = app.path().app_config_dir().ok().map(|d| d.join("launcher-history.json"));
    let history = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<History>(&t).ok())
        .unwrap_or_default();
    with_state(|s| {
        s.history.get_or_insert(history);
        s.history_path = path;
    });
}

fn save_history() {
    let Some((text, path)) = with_state(|s| {
        let text = serde_json::to_string(s.history.as_ref()?).ok()?;
        Some((text, s.history_path.clone()?))
    })
    .flatten() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/* ---------------- the window ---------------- */

/// The window that was in front before the box opened, to give the focus
/// back to when it closes without running anything.
static PREVIOUS: AtomicIsize = AtomicIsize::new(0);
/// Asked to open while the window was still being made: where from.
static PENDING: Mutex<Option<Option<(f64, f64)>>> = Mutex::new(None);
static SHOWN_AT: Mutex<Option<Instant>> = Mutex::new(None);
static MAKING: AtomicBool = AtomicBool::new(false);
static HOTKEY_OK: AtomicBool = AtomicBool::new(true);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub hotkey: String,
    pub hotkey_ok: bool,
}

pub fn status() -> Status {
    Status {
        enabled: settings().enabled,
        hotkey: config::hotkeys().open_launcher,
        hotkey_ok: HOTKEY_OK.load(Ordering::Relaxed),
    }
}

/// Called after the hotkeys were registered.
pub fn set_hotkey_ok(app: &AppHandle, ok: bool) {
    let before = HOTKEY_OK.swap(ok, Ordering::Relaxed);
    if !ok {
        log::write("launcher: its hotkey is taken by another app");
    }
    if before != ok {
        let _ = app.emit(STATUS_EVENT, status());
    }
}

/// Makes the hidden window ahead of time ("keep ready"), or closes it when
/// the launcher is off or shouldn't stay in memory.
pub fn apply_settings(app: &AppHandle) {
    let s = settings();
    let window = app.get_webview_window(LABEL);
    if s.enabled && s.keep_ready {
        if window.is_none() {
            make_window(app);
        }
    } else if let Some(w) = window {
        if !w.is_visible().unwrap_or(false) {
            let _ = w.destroy();
        }
    }
}

/// Builds the window on a thread of its own (building one from the main
/// thread can deadlock WebView2, see `open_settings_window`).
fn make_window(app: &AppHandle) {
    if MAKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("launcher.html".into()))
            .title("Dynamic Launcher")
            .inner_size(WIDTH, HEIGHT)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .shadow(false)
            .focused(false)
            .visible(false)
            .build();
        match built {
            Ok(w) => {
                let handle = app.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::Focused(false) = e {
                        // Clicking somewhere else closes the box; not in the
                        // first moments after it opened, while Windows is
                        // still handing over the focus.
                        let fresh = SHOWN_AT.lock().ok().and_then(|t| *t).is_some_and(|t| t.elapsed() < Duration::from_millis(300));
                        if !fresh {
                            let _ = handle.emit_to(LABEL, CLOSE_EVENT, false);
                        }
                    }
                });
            }
            Err(e) => log::write(&format!("launcher: the window can't be made: {e}")),
        }
        MAKING.store(false, Ordering::SeqCst);
    });
}

/// The page has loaded: open it if that was asked for in the meantime.
pub fn page_ready(app: &AppHandle) {
    let pending = PENDING.lock().ok().and_then(|mut p| p.take());
    if let Some(origin) = pending {
        if let Some(w) = app.get_webview_window(LABEL) {
            show(app, &w, origin);
        }
    }
}

/// The hotkey or the dock's button: open the box, or close it when open.
/// `origin` is a point on the screen (physical pixels) to grow from.
pub fn toggle(app: &AppHandle, origin: Option<(f64, f64)>) {
    if !settings().enabled {
        return;
    }
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = app.emit_to(LABEL, CLOSE_EVENT, true);
        }
        Some(w) => show(app, &w, origin),
        None => {
            if let Ok(mut p) = PENDING.lock() {
                *p = Some(origin);
            }
            make_window(app);
        }
    }
}

fn show(app: &AppHandle, w: &WebviewWindow, origin: Option<(f64, f64)>) {
    remember_foreground(w);
    refresh_apps(app, false);
    // On the screen with the pointer, in the upper part of it.
    let cursor = app.cursor_position().ok();
    let monitors = w.available_monitors().unwrap_or_default();
    let monitor = cursor
        .and_then(|c| {
            monitors.iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                c.x >= p.x as f64 && c.y >= p.y as f64 && c.x < (p.x + s.width as i32) as f64 && c.y < (p.y + s.height as i32) as f64
            })
        })
        .cloned()
        .or_else(|| w.primary_monitor().ok().flatten());
    let mut from = None;
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let (mp, ms) = (m.position(), m.size());
        let width = (WIDTH * scale).round();
        let height = (HEIGHT * scale).round();
        let x = mp.x as f64 + (ms.width as f64 - width) / 2.0;
        let y = mp.y as f64 + ms.height as f64 * TOP;
        let _ = w.set_size(PhysicalSize::new(width as u32, height as u32));
        let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        from = origin.map(|(ox, oy)| ((ox - x) / scale, (oy - y) / scale));
    }
    if let Ok(mut t) = SHOWN_AT.lock() {
        *t = Some(Instant::now());
    }
    let _ = app.emit_to(LABEL, SHOW_EVENT, from.map(|(x, y)| serde_json::json!({ "x": x, "y": y })));
    let _ = w.show();
    let _ = w.set_focus();
    bring_forward(w);
}

/// Hides the box. `restore`: nothing was run, give the focus back to the
/// window that had it.
pub fn hide(app: &AppHandle, restore: bool) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let _ = w.hide();
    if restore {
        restore_foreground();
    }
    let s = settings();
    if !s.keep_ready || !s.enabled {
        let _ = w.destroy();
    }
}

#[cfg(windows)]
fn remember_foreground(w: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let fg = unsafe { GetForegroundWindow() }.0 as isize;
    let mine = w.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if fg != mine {
        PREVIOUS.store(fg, Ordering::Relaxed);
    }
}

#[cfg(windows)]
fn restore_foreground() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let prev = PREVIOUS.swap(0, Ordering::Relaxed);
    if prev == 0 {
        return;
    }
    let hwnd = HWND(prev as _);
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// The hotkey gives this process the right to take the foreground; use it
/// so typing goes straight into the box.
#[cfg(windows)]
fn bring_forward(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    if let Ok(raw) = w.hwnd() {
        unsafe {
            let _ = SetForegroundWindow(HWND(raw.0 as _));
        }
    }
}

#[cfg(not(windows))]
fn remember_foreground(_w: &WebviewWindow) {}
#[cfg(not(windows))]
fn restore_foreground() {}
#[cfg(not(windows))]
fn bring_forward(_w: &WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_queries_are_encoded() {
        assert_eq!(web_url("google", "çay & simit"), "https://www.google.com/search?q=%C3%A7ay+%26+simit");
        assert!(web_url("duckduckgo", "x").starts_with("https://duckduckgo.com/"));
    }

    #[test]
    fn names_from_paths() {
        assert_eq!(base_name(r"C:\Tools\deploy.ps1"), "deploy");
        assert_eq!(base_name(r"D:\Projects\"), "Projects");
        assert_eq!(base_name("https://www.github.com/x"), "github.com");
    }
}
