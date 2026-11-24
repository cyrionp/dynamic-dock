//! The counter over the screen: a tiny native window (no web page, so it
//! costs almost no memory) that stays on top, lets every click through to
//! the game below and redraws once a second.
//!
//! It shows over games in a window or borderless full screen. A game in
//! exclusive full screen owns the display, and Windows shows nothing else
//! on top of it; switch such a game to borderless to see the counter.
//!
//! "Move" makes it take the pointer for a moment: drag it anywhere, then
//! double-click or right-click it (or press Done on the dock) to pin it.

#[cfg(not(windows))]
pub fn show() {}
#[cfg(not(windows))]
pub fn hide() {}
#[cfg(not(windows))]
pub fn update(_fps: u32) {}
#[cfg(not(windows))]
pub fn set_moving(_on: bool) {}

#[cfg(windows)]
pub use imp::{hide, set_moving, show, update};

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
        FrameRect, GetMonitorInfoW, InvalidateRect, MonitorFromPoint, SelectObject, SetBkMode, SetTextColor,
        SetWindowRgn, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE,
        DT_VCENTER, FF_DONTCARE, FW_SEMIBOLD, HFONT, MONITORINFO, MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS,
        PAINTSTRUCT, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, GetWindowLongPtrW,
        GetWindowRect, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassExW, SetCursor,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, CS_DBLCLKS,
        GWL_EXSTYLE, HWND_TOPMOST, IDC_SIZEALL, LWA_ALPHA, MA_NOACTIVATE, MSG, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WM_APP, WM_CLOSE, WM_DESTROY, WM_DPICHANGED, WM_ERASEBKGND,
        WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_NCHITTEST, WM_PAINT,
        WM_RBUTTONUP, WM_SETCURSOR, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT, WS_POPUP, HTCLIENT,
    };

    const WM_FPS: u32 = WM_APP + 1;
    const WM_MOVE_MODE: u32 = WM_APP + 2;

    /// The window, 0 while there is none.
    static HWND_RAW: AtomicIsize = AtomicIsize::new(0);
    /// Whether the window should be up; the thread checks it after building.
    static WANTED: AtomicBool = AtomicBool::new(false);
    static THREAD: AtomicBool = AtomicBool::new(false);
    static MOVING: AtomicBool = AtomicBool::new(false);
    static FPS: AtomicU32 = AtomicU32::new(0);
    static FONT: AtomicIsize = AtomicIsize::new(0);
    /// Pointer offset inside the window while dragging; i32::MIN when not.
    static GRAB_X: AtomicIsize = AtomicIsize::new(isize::MIN);
    static GRAB_Y: AtomicIsize = AtomicIsize::new(0);

    /// Size in pixels at 100 % scaling.
    const WIDTH: f64 = 96.0;
    const HEIGHT: f64 = 32.0;

    fn hwnd() -> Option<HWND> {
        match HWND_RAW.load(Ordering::SeqCst) {
            0 => None,
            h => Some(HWND(h as _)),
        }
    }

    pub fn show() {
        WANTED.store(true, Ordering::SeqCst);
        if THREAD.swap(true, Ordering::SeqCst) {
            return;
        }
        let spawned = std::thread::Builder::new().name("fps-overlay".into()).spawn(|| {
            while WANTED.load(Ordering::SeqCst) {
                run();
            }
            THREAD.store(false, Ordering::SeqCst);
            // A show() that came in while this thread was finishing.
            if WANTED.load(Ordering::SeqCst) {
                show();
            }
        });
        if spawned.is_err() {
            THREAD.store(false, Ordering::SeqCst);
        }
    }

    pub fn hide() {
        WANTED.store(false, Ordering::SeqCst);
        MOVING.store(false, Ordering::SeqCst);
        if let Some(h) = hwnd() {
            unsafe {
                let _ = PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn update(fps: u32) {
        FPS.store(fps, Ordering::Relaxed);
        if let Some(h) = hwnd() {
            unsafe {
                let _ = PostMessageW(Some(h), WM_FPS, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn set_moving(on: bool) {
        MOVING.store(on, Ordering::SeqCst);
        if let Some(h) = hwnd() {
            unsafe {
                let _ = PostMessageW(Some(h), WM_MOVE_MODE, WPARAM(0), LPARAM(0));
            }
        }
    }

    /* ---------- position ---------- */

    fn position_file() -> Option<std::path::PathBuf> {
        crate::log::dir().map(|d| d.join("fps-overlay.json"))
    }

    fn load_position() -> Option<(i32, i32)> {
        let text = std::fs::read_to_string(position_file()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
    }

    fn save_position(hwnd: HWND) {
        let mut r = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
            return;
        }
        if let Some(path) = position_file() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, serde_json::json!({ "x": r.left, "y": r.top }).to_string());
        }
    }

    /// Keeps the window fully on the screen nearest to (x, y).
    fn clamp(x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
        unsafe {
            let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return (x, y);
            }
            let m = info.rcMonitor;
            (x.clamp(m.left, (m.right - w).max(m.left)), y.clamp(m.top, (m.bottom - h).max(m.top)))
        }
    }

    /* ---------- the window ---------- */

    fn scale(hwnd: HWND) -> f64 {
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }

    /// Size, rounded corners and font for the window's current scaling.
    fn layout(hwnd: HWND, s: f64) {
        let (w, h) = ((WIDTH * s).round() as i32, (HEIGHT * s).round() as i32);
        let radius = (10.0 * s).round() as i32;
        unsafe {
            let _ = SetWindowPos(hwnd, None, 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
            // The window owns the region from here on.
            SetWindowRgn(hwnd, Some(region), true);
            let font = CreateFontW(
                -((17.0 * s).round() as i32),
                0,
                0,
                0,
                FW_SEMIBOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                CLEARTYPE_QUALITY,
                FF_DONTCARE.0 as u32,
                w!("Segoe UI"),
            );
            let old = FONT.swap(font.0 as isize, Ordering::SeqCst);
            if old != 0 {
                let _ = DeleteObject(HFONT(old as _).into());
            }
        }
    }

    fn set_click_through(hwnd: HWND, through: bool) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let flag = WS_EX_TRANSPARENT.0 as isize;
            let next = if through { ex | flag } else { ex & !flag };
            if next != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
            }
        }
    }

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16)
    }

    fn paint(hwnd: HWND) {
        unsafe {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut r = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut r);
            let bg = CreateSolidBrush(rgb(18, 18, 24));
            FillRect(hdc, &r, bg);
            let _ = DeleteObject(bg.into());
            let moving = MOVING.load(Ordering::SeqCst);
            if moving {
                let edge = CreateSolidBrush(rgb(96, 165, 250));
                FrameRect(hdc, &r, edge);
                let inner = RECT { left: r.left + 1, top: r.top + 1, right: r.right - 1, bottom: r.bottom - 1 };
                FrameRect(hdc, &inner, edge);
                let _ = DeleteObject(edge.into());
            }
            let fps = FPS.load(Ordering::Relaxed);
            let color = match fps {
                0 => rgb(230, 230, 235),
                1..=29 => rgb(248, 113, 113),
                30..=59 => rgb(251, 191, 36),
                _ => rgb(74, 222, 128),
            };
            let font = FONT.load(Ordering::SeqCst);
            if font != 0 {
                SelectObject(hdc, HFONT(font as _).into());
            }
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, color);
            let mut text: Vec<u16> = format!("{fps} FPS").encode_utf16().collect();
            DrawTextW(hdc, &mut text, &mut r, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            let _ = EndPaint(hwnd, &ps);
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_FPS => {
                // Games can be topmost too; stay above them.
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_MOVE_MODE => {
                let moving = MOVING.load(Ordering::SeqCst);
                set_click_through(hwnd, !moving);
                if !moving {
                    save_position(hwnd);
                }
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                paint(hwnd);
                LRESULT(0)
            }
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_NCHITTEST => LRESULT(HTCLIENT as isize),
            WM_SETCURSOR if MOVING.load(Ordering::SeqCst) => {
                if let Ok(c) = LoadCursorW(None, IDC_SIZEALL) {
                    SetCursor(Some(c));
                }
                LRESULT(1)
            }
            WM_LBUTTONDOWN => {
                let mut p = POINT::default();
                let mut r = RECT::default();
                if GetCursorPos(&mut p).is_ok() && GetWindowRect(hwnd, &mut r).is_ok() {
                    GRAB_X.store((p.x - r.left) as isize, Ordering::SeqCst);
                    GRAB_Y.store((p.y - r.top) as isize, Ordering::SeqCst);
                    SetCapture(hwnd);
                }
                LRESULT(0)
            }
            WM_MOUSEMOVE => {
                let gx = GRAB_X.load(Ordering::SeqCst);
                if gx != isize::MIN {
                    let mut p = POINT::default();
                    let mut r = RECT::default();
                    if GetCursorPos(&mut p).is_ok() && GetWindowRect(hwnd, &mut r).is_ok() {
                        let (x, y) = clamp(
                            p.x - gx as i32,
                            p.y - GRAB_Y.load(Ordering::SeqCst) as i32,
                            r.right - r.left,
                            r.bottom - r.top,
                        );
                        let _ = SetWindowPos(hwnd, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                    }
                }
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                if GRAB_X.swap(isize::MIN, Ordering::SeqCst) != isize::MIN {
                    let _ = ReleaseCapture();
                    save_position(hwnd);
                }
                LRESULT(0)
            }
            WM_LBUTTONDBLCLK | WM_RBUTTONUP => {
                // Pinned again: tell the dock too.
                std::thread::spawn(|| super::super::set_moving(false));
                LRESULT(0)
            }
            WM_DPICHANGED => {
                let dpi = (w.0 & 0xFFFF) as f64;
                layout(hwnd, if dpi > 0.0 { dpi / 96.0 } else { 1.0 });
                let _ = InvalidateRect(Some(hwnd), None, false);
                LRESULT(0)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, w, l),
        }
    }

    /// Builds the window and runs its messages until it is closed.
    fn run() {
        unsafe {
            let Ok(module) = GetModuleHandleW(None) else { return };
            let class = HSTRING::from("DynamicDockFpsOverlay");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_DBLCLKS,
                lpfnWndProc: Some(proc),
                hInstance: module.into(),
                lpszClassName: windows::core::PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            // Fails harmlessly when it is already registered.
            RegisterClassExW(&wc);
            let (x, y) = load_position().unwrap_or((24, 24));
            let Ok(hwnd) = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                &class,
                w!("FPS"),
                WS_POPUP,
                x,
                y,
                WIDTH as i32,
                HEIGHT as i32,
                None,
                None,
                Some(module.into()),
                None,
            ) else {
                WANTED.store(false, Ordering::SeqCst);
                return;
            };
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 225, LWA_ALPHA);
            let s = scale(hwnd);
            layout(hwnd, s);
            let (w, h) = ((WIDTH * s).round() as i32, (HEIGHT * s).round() as i32);
            let (x, y) = clamp(x, y, w, h);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
            set_click_through(hwnd, !MOVING.load(Ordering::SeqCst));
            HWND_RAW.store(hwnd.0 as isize, Ordering::SeqCst);
            if !WANTED.load(Ordering::SeqCst) {
                let _ = DestroyWindow(hwnd);
            } else {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            HWND_RAW.store(0, Ordering::SeqCst);
            GRAB_X.store(isize::MIN, Ordering::SeqCst);
            let font = FONT.swap(0, Ordering::SeqCst);
            if font != 0 {
                let _ = DeleteObject(HFONT(font as _).into());
            }
        }
    }
}
