//! A small log file, so a problem on someone's PC can be traced afterwards.
//!
//! `%LOCALAPPDATA%\DynamicDock\dock.log`; when it passes 1 MB at start it
//! moves to `dock.old.log`. The dock, its watchdog and `--restore-taskbar`
//! all append to the same file, each line tagged with its process id.

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX: u64 = 1024 * 1024;

pub fn dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("DynamicDock"))
}

fn path() -> Option<PathBuf> {
    dir().map(|d| d.join("dock.log"))
}

/// Called once by the dock at start: rotates a big log and writes a header.
pub fn init() {
    let Some(path) = path() else { return };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_file_name("dock.old.log"));
    }
    write(&format!("---- Dynamic Dock {} starting ----", env!("CARGO_PKG_VERSION")));
}

/// Appends one line. Never fails loudly: logging must not break the dock.
pub fn write(msg: &str) {
    let Some(path) = path() else { return };
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} [{}] {}", timestamp(), std::process::id(), msg);
    }
}

/// UTC time as "YYYY-MM-DD HH:MM:SS".
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

macro_rules! log {
    ($($arg:tt)*) => { $crate::log::write(&format!($($arg)*)) };
}
pub(crate) use log;
