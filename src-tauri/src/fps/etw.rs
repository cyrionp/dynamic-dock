//! A tiny real-time ETW session that only listens to the frame-present
//! events of DXGI (Direct3D 10/11/12) and Direct3D 9, filtered by event id
//! inside Windows, and counts those of one process.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use windows::core::{w, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_SUCCESS, WIN32_ERROR};
use windows::Win32::System::Diagnostics::Etw::{
    CloseTrace, ControlTraceW, EnableTraceEx2, OpenTraceW, ProcessTrace, StartTraceW, CONTROLTRACE_HANDLE,
    ENABLE_TRACE_PARAMETERS, ENABLE_TRACE_PARAMETERS_VERSION_2, EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_FILTER_DESCRIPTOR,
    EVENT_RECORD, EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES, EVENT_TRACE_REAL_TIME_MODE,
    PROCESS_TRACE_MODE_EVENT_RECORD, PROCESS_TRACE_MODE_REAL_TIME, WNODE_FLAG_TRACED_GUID,
};
use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;

const EVENT_TRACE_USE_MS_FLUSH_TIMER: u32 = 0x0000_0010;

const SESSION: PCWSTR = w!("DynamicDockFps");
const SESSION_NAME: &str = "DynamicDockFps";

/// Microsoft-Windows-DXGI: Present_Start (42), PresentMultiplaneOverlay_Start (55).
const DXGI: GUID = GUID::from_u128(0xCA11C036_0102_4A2D_A6AD_F03CFED5D3C9);
/// Microsoft-Windows-D3D9: Present_Start (1).
const D3D9: GUID = GUID::from_u128(0x783ACA0A_790E_4D7F_8451_AA850511C6B9);

const EVENT_FILTER_TYPE_EVENT_ID: u32 = 0x8000_0200;
const TRACE_LEVEL_INFORMATION: u8 = 4;

/// The process whose frames are counted.
static WATCHED: AtomicU32 = AtomicU32::new(0);

/// Frames per 100 ms slot of event time, in a ring. Counting by the time
/// stamp of each frame (not by when the event reached the dock) keeps the
/// number steady even though Windows hands events over in batches. Only
/// the trace's reader thread writes; relaxed atomics are plenty.
const SLOTS: usize = 32;
/// 100 ms in FILETIME units (100 ns).
const SLOT: i64 = 1_000_000;

struct Ring {
    slot: [AtomicU64; SLOTS],
    count: [AtomicU32; SLOTS],
}

#[allow(clippy::declare_interior_mutable_const)]
impl Ring {
    const NO_SLOT: AtomicU64 = AtomicU64::new(0);
    const NO_COUNT: AtomicU32 = AtomicU32::new(0);

    const fn new() -> Self {
        Ring {
            slot: [Self::NO_SLOT; SLOTS],
            count: [Self::NO_COUNT; SLOTS],
        }
    }

    fn add(&self, time: i64) {
        let slot = (time / SLOT) as u64;
        let i = slot as usize % SLOTS;
        if self.slot[i].load(Ordering::Relaxed) != slot {
            self.slot[i].store(slot, Ordering::Relaxed);
            self.count[i].store(0, Ordering::Relaxed);
        }
        self.count[i].fetch_add(1, Ordering::Relaxed);
    }

    /// Frames in the slots `from..to`.
    fn sum(&self, from: u64, to: u64) -> u32 {
        (from..to)
            .map(|slot| {
                let i = slot as usize % SLOTS;
                if self.slot[i].load(Ordering::Relaxed) == slot {
                    self.count[i].load(Ordering::Relaxed)
                } else {
                    0
                }
            })
            .sum()
    }

    fn clear(&self) {
        for s in &self.slot {
            s.store(0, Ordering::Relaxed);
        }
    }
}

static DXGI_FRAMES: Ring = Ring::new();
static D3D9_FRAMES: Ring = Ring::new();

/// One session at a time: a quick stop and start waits for the old one.
static ONE: Mutex<()> = Mutex::new(());

/// Counts the frames of `pid` from now on (and forgets the others').
pub fn watch_process(pid: u32) {
    if WATCHED.swap(pid, Ordering::Relaxed) != pid {
        DXGI_FRAMES.clear();
        D3D9_FRAMES.clear();
    }
}

/// Frames in the second that ended 200 ms ago: by then Windows has
/// delivered all of its events (they are flushed every 100 ms). A
/// Direct3D 9 game can show up in both providers, so the larger count
/// wins instead of the sum.
pub fn frames_last_second() -> u32 {
    let now = unsafe { GetSystemTimePreciseAsFileTime() };
    let now = ((now.dwHighDateTime as u64) << 32 | now.dwLowDateTime as u64) / SLOT as u64;
    let (from, to) = (now.saturating_sub(12), now.saturating_sub(2));
    DXGI_FRAMES.sum(from, to).max(D3D9_FRAMES.sum(from, to))
}

unsafe extern "system" fn on_event(record: *mut EVENT_RECORD) {
    let Some(record) = record.as_ref() else { return };
    let header = &record.EventHeader;
    if header.ProcessId != WATCHED.load(Ordering::Relaxed) {
        return;
    }
    let id = header.EventDescriptor.Id;
    if header.ProviderId == DXGI && (id == 42 || id == 55) {
        DXGI_FRAMES.add(header.TimeStamp);
    } else if header.ProviderId == D3D9 && id == 1 {
        D3D9_FRAMES.add(header.TimeStamp);
    }
}

/// EVENT_TRACE_PROPERTIES with room for the session name after it.
#[repr(C)]
struct Properties {
    props: EVENT_TRACE_PROPERTIES,
    name: [u16; 64],
}

fn properties() -> Box<Properties> {
    let mut p = Box::new(Properties {
        props: EVENT_TRACE_PROPERTIES::default(),
        name: [0; 64],
    });
    p.props.Wnode.BufferSize = std::mem::size_of::<Properties>() as u32;
    p.props.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
    p.props.Wnode.ClientContext = 1; // QueryPerformanceCounter time stamps
    p.props.LogFileMode = EVENT_TRACE_REAL_TIME_MODE | EVENT_TRACE_USE_MS_FLUSH_TIMER;
    // Small buffers, handed over every 100 ms.
    p.props.BufferSize = 8; // KB
    p.props.MinimumBuffers = 2;
    p.props.MaximumBuffers = 8;
    p.props.FlushTimer = 100;
    p.props.LoggerNameOffset = std::mem::offset_of!(Properties, name) as u32;
    p
}

/// Ends the session by name, wherever it came from.
pub fn stop_stale_session() {
    let mut p = properties();
    unsafe {
        let _ = ControlTraceW(CONTROLTRACE_HANDLE::default(), SESSION, &mut p.props, EVENT_TRACE_CONTROL_STOP);
    }
}

/// Event ids to let through, laid out like EVENT_FILTER_EVENT_ID.
#[repr(C)]
struct EventIds<const N: usize> {
    filter_in: u8,
    reserved: u8,
    count: u16,
    events: [u16; N],
}

fn enable<const N: usize>(handle: CONTROLTRACE_HANDLE, provider: &GUID, ids: [u16; N]) -> WIN32_ERROR {
    let filter = EventIds { filter_in: 1, reserved: 0, count: N as u16, events: ids };
    let mut desc = EVENT_FILTER_DESCRIPTOR {
        Ptr: &filter as *const _ as u64,
        Size: std::mem::size_of::<EventIds<N>>() as u32,
        Type: EVENT_FILTER_TYPE_EVENT_ID,
    };
    let params = ENABLE_TRACE_PARAMETERS {
        Version: ENABLE_TRACE_PARAMETERS_VERSION_2,
        EnableFilterDesc: &mut desc,
        FilterDescCount: 1,
        ..Default::default()
    };
    unsafe {
        EnableTraceEx2(
            handle,
            provider,
            EVENT_CONTROL_CODE_ENABLE_PROVIDER.0,
            TRACE_LEVEL_INFORMATION,
            u64::MAX,
            0,
            0,
            Some(&params),
        )
    }
}

pub struct Session {
    thread: Option<JoinHandle<()>>,
    _one: MutexGuard<'static, ()>,
}

impl Session {
    /// Starts the session and its reader thread. The error is the Win32
    /// code: 5 (access denied) without the needed rights.
    pub fn start() -> Result<Session, u32> {
        let one = ONE.lock().unwrap_or_else(|e| e.into_inner());
        watch_process(0);

        let mut handle = CONTROLTRACE_HANDLE::default();
        let mut p = properties();
        let mut err = unsafe { StartTraceW(&mut handle, SESSION, &mut p.props) };
        if err == ERROR_ALREADY_EXISTS {
            stop_stale_session();
            p = properties();
            err = unsafe { StartTraceW(&mut handle, SESSION, &mut p.props) };
        }
        if err != ERROR_SUCCESS {
            return Err(err.0);
        }
        let dxgi = enable(handle, &DXGI, [42, 55]);
        let d3d9 = enable(handle, &D3D9, [1]);
        if dxgi != ERROR_SUCCESS && d3d9 != ERROR_SUCCESS {
            stop_stale_session();
            return Err(dxgi.0);
        }

        let mut name: Vec<u16> = SESSION_NAME.encode_utf16().chain(Some(0)).collect();
        let mut log = EVENT_TRACE_LOGFILEW {
            LoggerName: PWSTR(name.as_mut_ptr()),
            ..Default::default()
        };
        log.Anonymous1.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        log.Anonymous2.EventRecordCallback = Some(on_event);
        let trace = unsafe { OpenTraceW(&mut log) };
        if trace.Value == u64::MAX {
            stop_stale_session();
            return Err(windows::core::Error::from_thread().code().0 as u32);
        }
        let thread = std::thread::Builder::new()
            .name("fps-etw".into())
            .spawn(move || unsafe {
                // Returns once the session is stopped.
                let _ = ProcessTrace(&[trace], None, None);
                let _ = CloseTrace(trace);
            })
            .map_err(|_| {
                stop_stale_session();
                unsafe {
                    let _ = CloseTrace(trace);
                }
                0u32
            })?;
        Ok(Session { thread: Some(thread), _one: one })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        watch_process(0);
        stop_stale_session();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
