//! System meters: processor, memory, drives, network speed, battery and
//! uptime, sent as `sys://stats`.
//!
//! The worker only measures while the dock shows a widget that needs it:
//! the dock asks for an interval with `set_stats_interval`, and 0 stops it.

use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};

pub const STATS_EVENT: &str = "sys://stats";

/// Milliseconds between measurements; 0 while nothing needs them.
static INTERVAL: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub name: String,
    pub total: u64,
    pub free: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Processor use, 0–100.
    pub cpu: f64,
    /// Memory in use, 0–100, and the totals in bytes.
    pub memory: f64,
    pub memory_used: u64,
    pub memory_total: u64,
    pub drives: Vec<Drive>,
    /// Bytes per second.
    pub net_down: f64,
    pub net_up: f64,
    pub online: bool,
    /// Battery percentage, when there is a battery.
    pub battery: Option<u8>,
    pub charging: bool,
    pub uptime_secs: u64,
}

pub fn set_interval(ms: u32) {
    INTERVAL.store(if ms == 0 { 0 } else { ms.clamp(500, 60_000) }, Ordering::Relaxed);
}

pub fn init(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let app = app.clone();
    std::thread::Builder::new()
        .name("stats".into())
        .spawn(move || {
            let mut meter = imp::Meter::default();
            loop {
                let ms = INTERVAL.load(Ordering::Relaxed);
                if ms == 0 {
                    // Nobody is looking: forget the counters, check back later.
                    meter = imp::Meter::default();
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                    continue;
                }
                let stats = meter.read();
                let _ = app.emit(STATS_EVENT, stats);
                std::thread::sleep(std::time::Duration::from_millis(ms as u64));
            }
        })
        .ok();
}

#[cfg(not(windows))]
mod imp {
    use super::Stats;
    #[derive(Default)]
    pub struct Meter;
    impl Meter {
        pub fn read(&mut self) -> Stats {
            Stats::default()
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{Drive, Stats};
    use std::time::Instant;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    const DRIVE_FIXED: u32 = 3;
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

    #[derive(Default)]
    pub struct Meter {
        cpu: Option<(u64, u64)>,
        net: Option<(u64, u64, Instant)>,
        drives_at: Option<Instant>,
        drives: Vec<Drive>,
    }

    fn ft(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    impl Meter {
        pub fn read(&mut self) -> Stats {
            let mut s = Stats::default();

            // Processor: busy share of the time since the last reading.
            let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
            if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_ok() {
                let (idle, total) = (ft(idle), ft(kernel) + ft(user));
                if let Some((pi, pt)) = self.cpu {
                    let dt = total.saturating_sub(pt);
                    if dt > 0 {
                        s.cpu = (1.0 - idle.saturating_sub(pi) as f64 / dt as f64).clamp(0.0, 1.0) * 100.0;
                    }
                }
                self.cpu = Some((idle, total));
            }

            let mut mem = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                ..Default::default()
            };
            if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
                s.memory_total = mem.ullTotalPhys;
                s.memory_used = mem.ullTotalPhys.saturating_sub(mem.ullAvailPhys);
                s.memory = if mem.ullTotalPhys > 0 { s.memory_used as f64 / mem.ullTotalPhys as f64 * 100.0 } else { 0.0 };
            }

            // Drives change slowly: every 30 seconds is plenty.
            if self.drives_at.map_or(true, |t| t.elapsed().as_secs() >= 30) {
                self.drives = read_drives();
                self.drives_at = Some(Instant::now());
            }
            s.drives = self.drives.clone();

            let (down, up, online) = read_network();
            let now = Instant::now();
            if let Some((pd, pu, at)) = self.net {
                let secs = now.duration_since(at).as_secs_f64().max(0.001);
                s.net_down = down.saturating_sub(pd) as f64 / secs;
                s.net_up = up.saturating_sub(pu) as f64 / secs;
            }
            self.net = Some((down, up, now));
            s.online = online;

            let mut power = SYSTEM_POWER_STATUS::default();
            if unsafe { GetSystemPowerStatus(&mut power) }.is_ok() && power.BatteryFlag & 128 == 0 && power.BatteryLifePercent <= 100 {
                s.battery = Some(power.BatteryLifePercent);
                s.charging = power.ACLineStatus == 1;
            }
            s.uptime_secs = unsafe { GetTickCount64() } / 1000;
            s
        }
    }

    fn read_drives() -> Vec<Drive> {
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let path = HSTRING::from(root.as_str());
            if unsafe { GetDriveTypeW(&path) } != DRIVE_FIXED {
                continue;
            }
            let (mut total, mut free) = (0u64, 0u64);
            if unsafe { GetDiskFreeSpaceExW(&path, None, Some(&mut total), Some(&mut free)) }.is_ok() && total > 0 {
                out.push(Drive {
                    name: root[..2].to_string(),
                    total,
                    free,
                });
            }
        }
        out
    }

    /// Bytes received and sent by the physical network adapters so far, and
    /// whether any of them is connected.
    fn read_network() -> (u64, u64, bool) {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if unsafe { GetIfTable2(&mut table) }.is_err() || table.is_null() {
            return (0, 0, false);
        }
        let (mut down, mut up, mut online) = (0u64, 0u64, false);
        unsafe {
            let count = (*table).NumEntries as usize;
            let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), count);
            for row in rows {
                // Bit 0: a real (hardware) adapter, not a filter or tunnel.
                let hardware = row.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
                if !hardware || row.Type == IF_TYPE_SOFTWARE_LOOPBACK || row.OperStatus != IfOperStatusUp {
                    continue;
                }
                online = true;
                down += row.InOctets;
                up += row.OutOctets;
            }
            FreeMibTable(table as *const _);
        }
        (down, up, online)
    }
}
