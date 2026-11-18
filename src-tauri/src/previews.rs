//! Window previews for the dock's window list, like the taskbar's.
//!
//! Each window is drawn into a bitmap with `PrintWindow` (with
//! `PW_RENDERFULLCONTENT`, so browsers and other GPU-drawn windows come out
//! too), cut to the visible frame, scaled down to fit the size the dock asks
//! for and sent back as a PNG `data:` URL. A minimised window can't be drawn,
//! so it has no preview and the dock shows the app's icon instead.

#[cfg(windows)]
pub use imp::capture;

#[cfg(not(windows))]
pub fn capture(_hwnd: i64, _max_w: u32, _max_h: u32) -> Option<String> {
    None
}

#[cfg(windows)]
mod imp {
    use base64::Engine;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
        SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE,
        HBITMAP, HDC, SRCCOPY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindow, PW_RENDERFULLCONTENT};

    /// A preview of `hwnd` no bigger than `max_w`×`max_h`, or None.
    pub fn capture(hwnd: i64, max_w: u32, max_h: u32) -> Option<String> {
        let hwnd = HWND(hwnd as isize as _);
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() || IsIconic(hwnd).as_bool() {
                return None;
            }
            let mut win = RECT::default();
            GetWindowRect(hwnd, &mut win).ok()?;
            // The visible frame, without the invisible resize borders.
            let mut frame = RECT::default();
            let frame = if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut frame as *mut RECT as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                frame
            } else {
                win
            };
            let (ww, wh) = (win.right - win.left, win.bottom - win.top);
            let (fx, fy) = ((frame.left - win.left).max(0), (frame.top - win.top).max(0));
            let fw = (frame.right - frame.left).min(ww - fx);
            let fh = (frame.bottom - frame.top).min(wh - fy);
            if ww <= 0 || wh <= 0 || fw <= 0 || fh <= 0 || ww > 16_384 || wh > 16_384 {
                return None;
            }
            let scale = (max_w.max(16) as f64 / fw as f64).min(max_h.max(16) as f64 / fh as f64).min(1.0);
            let (tw, th) = (((fw as f64 * scale).round() as i32).max(1), ((fh as f64 * scale).round() as i32).max(1));

            let screen = GetDC(None);
            let full_dc = CreateCompatibleDC(Some(screen));
            let full = CreateCompatibleBitmap(screen, ww, wh);
            let small_dc = CreateCompatibleDC(Some(screen));
            let small = CreateCompatibleBitmap(screen, tw, th);
            ReleaseDC(None, screen);

            let old_full = SelectObject(full_dc, full.into());
            let old_small = SelectObject(small_dc, small.into());
            let drawn = PrintWindow(hwnd, full_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
            let result = if drawn {
                SetStretchBltMode(small_dc, HALFTONE);
                let _ = SetBrushOrgEx(small_dc, 0, 0, None);
                let _ = StretchBlt(small_dc, 0, 0, tw, th, Some(full_dc), fx, fy, fw, fh, SRCCOPY);
                SelectObject(small_dc, old_small);
                to_png(small_dc, small, tw, th)
            } else {
                SelectObject(small_dc, old_small);
                None
            };
            SelectObject(full_dc, old_full);
            let _ = DeleteObject(full.into());
            let _ = DeleteObject(small.into());
            let _ = DeleteDC(full_dc);
            let _ = DeleteDC(small_dc);
            result.map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
        }
    }

    unsafe fn to_png(dc: HDC, bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        if GetDIBits(dc, bitmap, 0, h as u32, Some(pixels.as_mut_ptr() as *mut _), &mut header, DIB_RGB_COLORS) == 0 {
            return None;
        }
        // An all-black picture means the window didn't draw itself.
        if pixels.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0) {
            return None;
        }
        // BGR(x) → RGB, opaque.
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for p in pixels.chunks_exact(4) {
            rgb.extend_from_slice(&[p[2], p[1], p[0]]);
        }
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&rgb).ok()?;
        }
        Some(out)
    }
}
