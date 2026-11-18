//! Notification counts on app icons (WhatsApp, Teams and other Store apps).
//!
//! These apps set their taskbar badge through Windows' notification system,
//! which keeps it in its own database (`wpndatabase.db`). Explorer's taskbar
//! reads it from there; nothing tells a replacement taskbar, so a worker reads
//! the badges from that database every few seconds and sends
//! `badges://update` when they change: app id (lower case) → badge, either a
//! number as text or "•" for a status glyph.
//!
//! The database is opened read-only with the SQLite that ships with Windows
//! (`winsqlite3.dll`), loaded at run time, so nothing is added to the app and
//! a PC without it simply shows no badges. When Windows keeps the file locked,
//! a copy of it (taken again only when it changes) is read instead.
//!
//! Apps that draw their count on their taskbar button instead (WhatsApp,
//! Discord, Teams…) are covered by `taskband`.

use std::collections::BTreeMap;

pub const BADGES_EVENT: &str = "badges://update";

pub type Badges = BTreeMap<String, String>;

#[cfg(windows)]
pub use imp::{init, snapshot};

#[cfg(not(windows))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn snapshot() -> Badges {
    Badges::new()
}

/// What a badge payload (`<badge value="3"/>`) shows, if anything.
fn badge_text(payload: &str) -> Option<String> {
    let start = payload.find("value=")? + "value=".len();
    let quote = payload[start..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &payload[start + 1..];
    let value = rest[..rest.find(quote)?].trim();
    match value.parse::<u32>() {
        Ok(0) => None,
        Ok(n) if n > 99 => Some("99+".into()),
        Ok(n) => Some(n.to_string()),
        Err(_) if value.is_empty() || value.eq_ignore_ascii_case("none") => None,
        // activity, alert, newMessage, busy…: a dot.
        Err(_) => Some("•".into()),
    }
}

#[cfg(windows)]
mod imp {
    use super::{badge_text, Badges, BADGES_EVENT};
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::{AppHandle, Emitter};
    use windows::core::{s, w};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    static CURRENT: Mutex<Badges> = Mutex::new(Badges::new());

    pub fn snapshot() -> Badges {
        CURRENT.lock().map(|b| b.clone()).unwrap_or_default()
    }

    pub fn init(app: &AppHandle) {
        let app = app.clone();
        std::thread::Builder::new()
            .name("badges".into())
            .spawn(move || {
                let Some(sql) = Sqlite::load() else {
                    crate::log::write("badges: winsqlite3.dll is missing, no notification counts");
                    return;
                };
                let Some(path) = std::env::var_os("LOCALAPPDATA")
                    .map(|d| PathBuf::from(d).join(r"Microsoft\Windows\Notifications\wpndatabase.db"))
                else {
                    return;
                };
                crate::log::write(&format!("badges: reading {}", path.display()));
                let copy = std::env::temp_dir().join("DynamicDock-wpndatabase.db");
                let mut copied: Option<Stamp> = None;
                let mut failed = false;
                let mut logged = false;
                loop {
                    let mut via_copy = false;
                    let result = sql.read(&path).or_else(|e| {
                        via_copy = true;
                        // Locked by Windows: read a copy, made again only once
                        // the original has changed.
                        let now = stamp(&path);
                        if copied.as_ref() != Some(&now) {
                            copy_db(&path, &copy).map_err(|c| format!("{e}; copying it failed too: {c}"))?;
                            copied = Some(now);
                        }
                        sql.read(&copy).map_err(|c| format!("{e}; reading a copy failed too: {c}"))
                    });
                    match result {
                        Ok(badges) => {
                            if !logged || failed {
                                logged = true;
                                let how = if via_copy { "a copy of " } else { "" };
                                crate::log::write(&format!("badges: reading {how}the notification database works"));
                            }
                            failed = false;
                            let changed = CURRENT.lock().map(|mut c| {
                                if *c == badges {
                                    false
                                } else {
                                    *c = badges.clone();
                                    true
                                }
                            });
                            if changed.unwrap_or(false) {
                                let list: Vec<String> = badges.iter().map(|(app, b)| format!("{app} = {b}")).collect();
                                crate::log::write(&format!("badges: now {}", if list.is_empty() { "none".into() } else { list.join(", ") }));
                                let _ = app.emit(BADGES_EVENT, badges);
                            }
                        }
                        Err(e) => {
                            // Busy now and then is normal; say it once.
                            if !failed {
                                crate::log::write(&format!("badges: {e}"));
                                failed = true;
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_secs(3));
                }
            })
            .ok();
    }

    /// Size and change time of the database and its journal.
    type Stamp = Vec<(u64, Option<SystemTime>)>;

    fn stamp(db: &Path) -> Stamp {
        [db.to_path_buf(), with_suffix(db, "-wal")]
            .iter()
            .map(|f| std::fs::metadata(f).map(|m| (m.len(), m.modified().ok())).unwrap_or((0, None)))
            .collect()
    }

    fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    }

    /// Copies the database with its write-ahead journal (where the newest
    /// rows wait); SQLite rebuilds the rest when it opens the copy.
    fn copy_db(from: &Path, to: &Path) -> Result<(), String> {
        std::fs::copy(from, to).map_err(|e| e.to_string())?;
        let wal = with_suffix(from, "-wal");
        let _ = std::fs::remove_file(with_suffix(to, "-shm"));
        if wal.exists() {
            std::fs::copy(&wal, with_suffix(to, "-wal")).map_err(|e| e.to_string())?;
        } else {
            let _ = std::fs::remove_file(with_suffix(to, "-wal"));
        }
        Ok(())
    }

    type Db = *mut c_void;
    type Stmt = *mut c_void;

    const SQLITE_OK: c_int = 0;
    const SQLITE_ROW: c_int = 100;
    const SQLITE_OPEN_READONLY: c_int = 0x1;

    type OpenV2 = unsafe extern "C" fn(*const c_char, *mut Db, c_int, *const c_char) -> c_int;
    type BusyTimeout = unsafe extern "C" fn(Db, c_int) -> c_int;
    type PrepareV2 = unsafe extern "C" fn(Db, *const c_char, c_int, *mut Stmt, *mut *const c_char) -> c_int;
    type BindInt64 = unsafe extern "C" fn(Stmt, c_int, i64) -> c_int;
    type StmtFn = unsafe extern "C" fn(Stmt) -> c_int;
    type ColumnText = unsafe extern "C" fn(Stmt, c_int) -> *const u8;
    type ColumnBlob = unsafe extern "C" fn(Stmt, c_int) -> *const c_void;
    type ColumnBytes = unsafe extern "C" fn(Stmt, c_int) -> c_int;
    type Close = unsafe extern "C" fn(Db) -> c_int;

    /// The few SQLite calls needed, from winsqlite3.dll.
    struct Sqlite {
        open_v2: OpenV2,
        busy_timeout: BusyTimeout,
        prepare_v2: PrepareV2,
        bind_int64: BindInt64,
        step: StmtFn,
        column_text: ColumnText,
        column_blob: ColumnBlob,
        column_bytes: ColumnBytes,
        finalize: StmtFn,
        close: Close,
    }

    impl Sqlite {
        fn load() -> Option<Self> {
            unsafe {
                let lib: HMODULE = LoadLibraryW(w!("winsqlite3.dll")).ok()?;
                macro_rules! get {
                    ($ty:ty, $name:literal) => {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(GetProcAddress(lib, s!($name))?)
                    };
                }
                Some(Self {
                    open_v2: get!(OpenV2, "sqlite3_open_v2"),
                    busy_timeout: get!(BusyTimeout, "sqlite3_busy_timeout"),
                    prepare_v2: get!(PrepareV2, "sqlite3_prepare_v2"),
                    bind_int64: get!(BindInt64, "sqlite3_bind_int64"),
                    step: get!(StmtFn, "sqlite3_step"),
                    column_text: get!(ColumnText, "sqlite3_column_text"),
                    column_blob: get!(ColumnBlob, "sqlite3_column_blob"),
                    column_bytes: get!(ColumnBytes, "sqlite3_column_bytes"),
                    finalize: get!(StmtFn, "sqlite3_finalize"),
                    close: get!(Close, "sqlite3_close"),
                })
            }
        }

        /// The badge of every app that has one. A later badge of the same app
        /// replaces an earlier one.
        fn read(&self, path: &std::path::Path) -> Result<Badges, String> {
            let file = CString::new(path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
            // Badges expire (after three days by default); Windows clears them
            // out on its own schedule, so skip the ones past their time.
            // ExpiryTime is a FILETIME: 100 ns steps since 1601.
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
            let filetime_now = (now + 11_644_473_600) * 10_000_000;
            let query = CString::new(
                "SELECT h.PrimaryId, n.Payload FROM Notification n \
                 JOIN NotificationHandler h ON h.RecordId = n.HandlerId \
                 WHERE n.Type = 'badge' AND (n.ExpiryTime IS NULL OR n.ExpiryTime <= 0 OR n.ExpiryTime > ?1) \
                 ORDER BY n.ArrivalTime",
            )
            .map_err(|e| e.to_string())?;
            unsafe {
                let mut db: Db = std::ptr::null_mut();
                let rc = (self.open_v2)(file.as_ptr(), &mut db, SQLITE_OPEN_READONLY, std::ptr::null());
                if rc != SQLITE_OK {
                    if !db.is_null() {
                        (self.close)(db);
                    }
                    return Err(format!("can't open the notification database (SQLite error {rc})"));
                }
                (self.busy_timeout)(db, 250);
                let mut stmt: Stmt = std::ptr::null_mut();
                let rc = (self.prepare_v2)(db, query.as_ptr(), -1, &mut stmt, std::ptr::null_mut());
                if rc != SQLITE_OK || stmt.is_null() {
                    (self.close)(db);
                    return Err(format!("can't read the notification database (SQLite error {rc})"));
                }
                (self.bind_int64)(stmt, 1, filetime_now);
                let mut out = Badges::new();
                while (self.step)(stmt) == SQLITE_ROW {
                    let app = text(self, stmt, 0);
                    let payload = {
                        let ptr = (self.column_blob)(stmt, 1) as *const u8;
                        let len = (self.column_bytes)(stmt, 1).max(0) as usize;
                        if ptr.is_null() || len == 0 {
                            String::new()
                        } else {
                            String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned()
                        }
                    };
                    if app.is_empty() {
                        continue;
                    }
                    let key = app.to_lowercase();
                    match badge_text(&payload) {
                        Some(badge) => {
                            out.insert(key, badge);
                        }
                        None => {
                            out.remove(&key);
                        }
                    }
                }
                (self.finalize)(stmt);
                (self.close)(db);
                Ok(out)
            }
        }
    }

    unsafe fn text(sql: &Sqlite, stmt: Stmt, col: c_int) -> String {
        let ptr = (sql.column_text)(stmt, col);
        if ptr.is_null() {
            return String::new();
        }
        let len = (sql.column_bytes)(stmt, col).max(0) as usize;
        String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::badge_text;

    #[test]
    fn reads_badges() {
        assert_eq!(badge_text(r#"<?xml version="1.0"?><badge value="3"/>"#).as_deref(), Some("3"));
        assert_eq!(badge_text(r#"<badge value='120'/>"#).as_deref(), Some("99+"));
        assert_eq!(badge_text(r#"<badge value="0"/>"#), None);
        assert_eq!(badge_text(r#"<badge value="none"/>"#), None);
        assert_eq!(badge_text(r#"<badge value="newMessage"/>"#).as_deref(), Some("•"));
        assert_eq!(badge_text("garbage"), None);
    }
}
