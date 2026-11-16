//! The system's master volume (the default playback device, through Core
//! Audio): read it, set it, step it with the mouse wheel, mute it.

use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// 0.0 – 1.0.
    pub level: f32,
    pub muted: bool,
}

#[cfg(windows)]
pub use imp::{change, get};

#[cfg(not(windows))]
pub fn get() -> Result<Volume, String> {
    Err("Volume control is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn change(_level: Option<f32>, _delta: Option<f32>, _mute: Option<bool>) -> Result<Volume, String> {
    Err("Volume control is only available on Windows".into())
}

#[cfg(windows)]
mod imp {
    use super::Volume;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            // Fails harmlessly when the thread already has COM set up.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            (|| -> windows::core::Result<IAudioEndpointVolume> {
                let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
                device.Activate(CLSCTX_ALL, None)
            })()
            .map_err(|e| e.message())
        }
    }

    fn read(e: &IAudioEndpointVolume) -> Volume {
        unsafe {
            Volume {
                level: e.GetMasterVolumeLevelScalar().unwrap_or(0.0),
                muted: e.GetMute().map(|m| m.as_bool()).unwrap_or(false),
            }
        }
    }

    pub fn get() -> Result<Volume, String> {
        Ok(read(&endpoint()?))
    }

    /// Sets the level, or moves it by `delta`, and/or (un)mutes. Turning it
    /// up also unmutes.
    pub fn change(level: Option<f32>, delta: Option<f32>, mute: Option<bool>) -> Result<Volume, String> {
        let e = endpoint()?;
        unsafe {
            let current = e.GetMasterVolumeLevelScalar().map_err(|e| e.message())?;
            let next = match (level, delta) {
                (Some(l), _) => Some(l),
                (None, Some(d)) => Some(current + d),
                _ => None,
            };
            if let Some(next) = next {
                let next = next.clamp(0.0, 1.0);
                e.SetMasterVolumeLevelScalar(next, std::ptr::null()).map_err(|e| e.message())?;
                if next > current {
                    let _ = e.SetMute(false, std::ptr::null());
                }
            }
            if let Some(m) = mute {
                let _ = e.SetMute(m, std::ptr::null());
            }
        }
        Ok(read(&e))
    }
}
