//! App icons as small PNG `data:` URLs for the dock.
//!
//! Icons come from the Windows shell (`IShellItemImageFactory`), which knows
//! about every kind of app: a plain `.exe`, a shortcut, or a Store app
//! addressed as `shell:AppsFolder\<AppUserModelID>`. The shell wants a
//! single-threaded COM apartment, so all lookups run on one worker thread,
//! and every result is cached for the rest of the session.

/// Pixel size of the icons handed to the dock: big enough for magnified
/// icons on a 150 % screen, small enough to keep memory low.
pub const ICON_PX: i32 = 96;

#[cfg(windows)]
pub use imp::get_many;
#[cfg(windows)]
pub use imp::icon_data_url;

#[cfg(not(windows))]
pub fn get_many(keys: Vec<String>) -> std::collections::HashMap<String, Option<String>> {
    keys.into_iter().map(|k| (k, None)).collect()
}

#[cfg(windows)]
mod imp {
    use super::ICON_PX;
    use base64::Engine;
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY};
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, HICON, ICONINFO};

    /// An icon handle (an app's overlay badge, say) as a PNG `data:` URL.
    pub fn icon_data_url(icon: HICON) -> Option<String> {
        unsafe {
            let mut info = ICONINFO::default();
            GetIconInfo(icon, &mut info).ok()?;
            let mask = (!info.hbmMask.is_invalid()).then_some(info.hbmMask);
            let png = if info.hbmColor.is_invalid() { None } else { to_png_masked(info.hbmColor, mask) };
            if !info.hbmColor.is_invalid() {
                let _ = DeleteObject(info.hbmColor.into());
            }
            if !info.hbmMask.is_invalid() {
                let _ = DeleteObject(info.hbmMask.into());
            }
            png.map(|bytes| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
        }
    }

    type Reply = Sender<HashMap<String, Option<String>>>;

    static WORKER: OnceLock<Mutex<Sender<(Vec<String>, Reply)>>> = OnceLock::new();

    fn worker() -> &'static Mutex<Sender<(Vec<String>, Reply)>> {
        WORKER.get_or_init(|| {
            let (tx, rx) = channel::<(Vec<String>, Reply)>();
            std::thread::Builder::new()
                .name("icons".into())
                .spawn(move || {
                    unsafe {
                        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                    }
                    let mut cache: HashMap<String, Option<String>> = HashMap::new();
                    while let Ok((keys, reply)) = rx.recv() {
                        let mut out = HashMap::new();
                        for key in keys {
                            let value = cache.entry(key.clone()).or_insert_with(|| load(&key)).clone();
                            out.insert(key, value);
                        }
                        let _ = reply.send(out);
                    }
                })
                .ok();
            Mutex::new(tx)
        })
    }

    /// Icons for these keys: a file path, or `shell:AppsFolder\<id>`.
    pub fn get_many(keys: Vec<String>) -> HashMap<String, Option<String>> {
        let (tx, rx) = channel();
        if let Ok(w) = worker().lock() {
            let _ = w.send((keys, tx));
        }
        rx.recv().unwrap_or_default()
    }

    fn load(key: &str) -> Option<String> {
        unsafe {
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(key), None).ok()?;
            let bitmap = factory
                .GetImage(SIZE { cx: ICON_PX, cy: ICON_PX }, SIIGBF_ICONONLY)
                .ok()?;
            let png = to_png_masked(bitmap, None);
            let _ = DeleteObject(bitmap.into());
            png.map(|bytes| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            })
        }
    }

    /// A bitmap's pixels as 32-bit BGRA rows, top to bottom.
    unsafe fn pixels_of(bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // Negative: rows top to bottom.
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(
            dc,
            bitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut header,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        (lines != 0).then_some(pixels)
    }

    /// A bitmap as PNG. `mask` is an icon's mask, used when the picture has
    /// no alpha of its own: white in it is see-through.
    unsafe fn to_png_masked(bitmap: HBITMAP, mask: Option<HBITMAP>) -> Option<Vec<u8>> {
        let mut info = BITMAP::default();
        if GetObjectW(bitmap.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut _)) == 0 {
            return None;
        }
        let (w, h) = (info.bmWidth, info.bmHeight.abs());
        if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
            return None;
        }
        let mut pixels = pixels_of(bitmap, w, h)?;
        let has_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
        let mask = if has_alpha { None } else { mask.and_then(|m| pixels_of(m, w, h)) };

        // BGRA, premultiplied → RGBA, straight. A bitmap without any alpha
        // is opaque, apart from what its mask cuts out.
        for (i, p) in pixels.chunks_exact_mut(4).enumerate() {
            p.swap(0, 2);
            if !has_alpha {
                let clear = mask.as_ref().is_some_and(|m| m[i * 4] != 0);
                p[3] = if clear { 0 } else { 255 };
            } else if p[3] > 0 && p[3] < 255 {
                let a = p[3] as u32;
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }

        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&pixels).ok()?;
        }
        Some(out)
    }
}
