//! Starting things and talking to Windows on the user's behalf: installed
//! apps (for pinning), launching apps, files and links, the Windows
//! shortcuts behind the Start, search and Task View buttons, background
//! (tray) apps, the Recycle Bin and the power menu.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// What Start calls it.
    pub name: String,
    /// The id inside `shell:AppsFolder`; launching and icons both use it.
    pub id: String,
    /// The program behind it, when Windows knows (for matching open windows).
    pub path: String,
}

/// One of the Windows taskbar's own pins (a shortcut in its pin folder).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarPin {
    pub name: String,
    /// The shortcut file; launching it keeps its arguments and start folder.
    pub link: String,
    /// What it points to (a program, usually).
    pub target: String,
    /// Its app id, when the shortcut carries one (for matching windows).
    pub app_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayApp {
    pub name: String,
    pub path: String,
    /// The icon Windows last showed in the tray, when it kept one.
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleBin {
    pub items: i64,
    pub bytes: i64,
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod fallback {
    use super::*;
    pub fn installed_apps() -> Vec<InstalledApp> {
        Vec::new()
    }
    pub fn taskbar_pins() -> Vec<TaskbarPin> {
        Vec::new()
    }
    pub fn launch(_target: &str, _args: &str, _admin: bool) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn launch_app(_id: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn shortcut(_name: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn tray_apps() -> Vec<TrayApp> {
        Vec::new()
    }
    pub fn recycle_bin() -> RecycleBin {
        RecycleBin::default()
    }
    pub fn empty_recycle_bin() -> Result<(), String> {
        Err("Windows only".into())
    }
    pub fn power(_action: &str) -> Result<(), String> {
        Err("Windows only".into())
    }
}

#[cfg(not(windows))]
pub use fallback::*;

#[cfg(windows)]
mod imp {
    use super::{InstalledApp, RecycleBin, TaskbarPin, TrayApp};
    use base64::Engine;
    use std::collections::HashSet;
    use windows::core::{w, Interface, GUID, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_ITEMS};
    use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_Link_TargetParsingPath};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Power::SetSuspendState;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::Shutdown::LockWorkStation;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_A, VK_D,
        VK_E, VK_I, VK_LWIN, VK_N, VK_R, VK_S, VK_SHIFT, VK_TAB, VK_V, VK_W, VK_X, VK_K,
    };
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, IShellItem2, SHCreateItemFromParsingName,
        SHEmptyRecycleBinW, SHGetKnownFolderPath, SHQueryRecycleBinW, ShellExecuteW, KF_FLAG_DEFAULT,
        SHERB_NOSOUND, SHQUERYRBINFO, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /* ---------------- installed apps ---------------- */

    /// Everything in Start's "All apps" list. Runs on its own thread, since
    /// the shell needs a single-threaded COM apartment.
    pub fn installed_apps() -> Vec<InstalledApp> {
        std::thread::spawn(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            list_apps_folder().unwrap_or_default()
        })
        .join()
        .unwrap_or_default()
    }

    unsafe fn list_apps_folder() -> windows::core::Result<Vec<InstalledApp>> {
        let folder: IShellItem = SHCreateItemFromParsingName(w!("shell:AppsFolder"), None)?;
        let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        loop {
            let mut fetched = 0u32;
            let mut batch: [Option<IShellItem>; 1] = [None];
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = batch[0].take() else { break };
            let name = display_name(&item, SIGDN_NORMALDISPLAY).unwrap_or_default();
            let id = display_name(&item, SIGDN_PARENTRELATIVEPARSING).unwrap_or_default();
            if name.is_empty() || id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let path = item
                .cast::<IShellItem2>()
                .ok()
                .and_then(|i2| i2.GetString(&PKEY_Link_TargetParsingPath).ok())
                .map(|p| {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const _));
                    s
                })
                .filter(|s| !s.is_empty())
                .or_else(|| resolve_known_folder(&id))
                .unwrap_or_default();
            out.push(InstalledApp { name, id, path });
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        Ok(out)
    }

    /// The Windows taskbar's pinned shortcuts, in its pin folder's order
    /// (by name; Windows keeps the real order elsewhere, in a binary blob).
    pub fn taskbar_pins() -> Vec<TaskbarPin> {
        std::thread::spawn(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            list_taskbar_pins().unwrap_or_default()
        })
        .join()
        .unwrap_or_default()
    }

    unsafe fn list_taskbar_pins() -> windows::core::Result<Vec<TaskbarPin>> {
        let Some(appdata) = std::env::var_os("APPDATA") else { return Ok(Vec::new()) };
        let dir = std::path::Path::new(&appdata).join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar");
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(out) };
        let mut files: Vec<_> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")))
            .collect();
        files.sort();
        for file in files {
            let link = file.to_string_lossy().to_string();
            let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem2>(&HSTRING::from(link.as_str()), None) else {
                continue;
            };
            let get = |key| {
                item.GetString(key).ok().map(|p| {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const _));
                    s
                })
            };
            let target = get(&PKEY_Link_TargetParsingPath)
                .filter(|s| !s.is_empty())
                .map(|t| resolve_known_folder(&t).unwrap_or(t))
                .unwrap_or_default();
            let app_id = get(&PKEY_AppUserModel_ID).unwrap_or_default();
            let name = file.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            out.push(TaskbarPin { name, link, target, app_id });
        }
        Ok(out)
    }

    unsafe fn display_name(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> Option<String> {
        let p = item.GetDisplayName(kind).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }

    /// `{GUID}\rest\of\path` → the known folder's real path plus the rest.
    pub(crate) fn resolve_known_folder(path: &str) -> Option<String> {
        let rest = path.strip_prefix('{')?;
        let (guid, tail) = rest.split_once('}')?;
        let hex: String = guid.chars().filter(|c| *c != '-').collect();
        let value = u128::from_str_radix(&hex, 16).ok()?;
        let id = GUID::from_u128(value);
        unsafe {
            let base = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None).ok()?;
            let s = base.to_string().ok();
            CoTaskMemFree(Some(base.0 as *const _));
            s.map(|b| format!("{b}{tail}"))
        }
    }

    /* ---------------- launching ---------------- */

    pub fn launch(target: &str, args: &str, admin: bool) -> Result<(), String> {
        let verb = if admin { w!("runas") } else { w!("open") };
        let file = HSTRING::from(target);
        let params = HSTRING::from(args);
        let result = unsafe {
            ShellExecuteW(
                None,
                verb,
                &file,
                if args.is_empty() { PCWSTR::null() } else { PCWSTR(params.as_ptr()) },
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        // Values above 32 mean success.
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("Couldn't open {target}"))
        }
    }

    /// Starts an app from Start's list by its AppsFolder id.
    pub fn launch_app(id: &str) -> Result<(), String> {
        launch("explorer.exe", &format!("shell:AppsFolder\\{id}"), false)
    }

    /* ---------------- Windows shortcuts ---------------- */

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                    ..Default::default()
                },
            },
        }
    }

    /// Presses the keys down in order, then lets go in reverse.
    fn press(keys: &[VIRTUAL_KEY]) {
        let mut inputs: Vec<INPUT> = keys.iter().map(|k| key(*k, false)).collect();
        inputs.extend(keys.iter().rev().map(|k| key(*k, true)));
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// The buttons that open parts of Windows itself.
    pub fn shortcut(name: &str) -> Result<(), String> {
        match name {
            "start" => press(&[VK_LWIN]),
            "search" => press(&[VK_LWIN, VK_S]),
            "taskview" => press(&[VK_LWIN, VK_TAB]),
            "desktop" => press(&[VK_LWIN, VK_D]),
            "notifications" => press(&[VK_LWIN, VK_N]),
            "quicksettings" => press(&[VK_LWIN, VK_A]),
            "widgets" => press(&[VK_LWIN, VK_W]),
            "clipboard" => press(&[VK_LWIN, VK_V]),
            "snip" => press(&[VK_LWIN, VK_SHIFT, VK_S]),
            "run" => press(&[VK_LWIN, VK_R]),
            "explorer" => press(&[VK_LWIN, VK_E]),
            "settings" => press(&[VK_LWIN, VK_I]),
            "quicklink" => press(&[VK_LWIN, VK_X]),
            "cast" => press(&[VK_LWIN, VK_K]),
            other => return Err(format!("Unknown shortcut: {other}")),
        }
        Ok(())
    }

    /* ---------------- tray apps ---------------- */

    fn running_programs() -> HashSet<String> {
        let mut out = HashSet::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut ok = Process32FirstW(snap, &mut entry).is_ok();
            while ok {
                if let Some(path) = crate::tasks::exe_of_pid(entry.th32ProcessID) {
                    out.insert(path.to_lowercase());
                }
                ok = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn reg_string(root: HKEY, sub: &str, name: PCWSTR) -> Option<String> {
        let sub = HSTRING::from(sub);
        let mut size = 0u32;
        unsafe {
            RegGetValueW(root, &sub, name, RRF_RT_REG_SZ, None, None, Some(&mut size)).ok().ok()?;
            let mut buf = vec![0u16; (size as usize / 2) + 1];
            RegGetValueW(root, &sub, name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size))
                .ok()
                .ok()?;
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        }
    }

    fn reg_binary(root: HKEY, sub: &str, name: PCWSTR) -> Option<Vec<u8>> {
        let sub = HSTRING::from(sub);
        let mut size = 0u32;
        unsafe {
            RegGetValueW(root, &sub, name, RRF_RT_REG_BINARY, None, None, Some(&mut size)).ok().ok()?;
            let mut buf = vec![0u8; size as usize];
            RegGetValueW(root, &sub, name, RRF_RT_REG_BINARY, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size))
                .ok()
                .ok()?;
            buf.truncate(size as usize);
            Some(buf)
        }
    }

    /// Apps running in the background with a notification-area icon.
    /// Windows 11 keeps a record of every tray icon (program, tooltip, last
    /// icon) under `NotifyIconSettings`; the running ones are listed.
    pub fn tray_apps() -> Vec<TrayApp> {
        const ROOT: &str = "Control Panel\\NotifyIconSettings";
        let running = running_programs();
        let mut out: Vec<TrayApp> = Vec::new();
        let mut seen = HashSet::new();
        unsafe {
            let mut key = HKEY::default();
            if RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(ROOT), None, KEY_READ, &mut key).is_err() {
                return out;
            }
            let mut index = 0u32;
            loop {
                let mut name = [0u16; 256];
                let mut len = name.len() as u32;
                let err = RegEnumKeyExW(key, index, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None);
                if err == ERROR_NO_MORE_ITEMS || err.is_err() {
                    break;
                }
                index += 1;
                let sub = format!("{ROOT}\\{}", String::from_utf16_lossy(&name[..len as usize]));
                let Some(raw) = reg_string(HKEY_CURRENT_USER, &sub, w!("ExecutablePath")) else { continue };
                let path = resolve_known_folder(&raw).unwrap_or(raw);
                let lower = path.to_lowercase();
                if lower.ends_with("\\explorer.exe") || !running.contains(&lower) || !seen.insert(lower) {
                    continue;
                }
                let tooltip = reg_string(HKEY_CURRENT_USER, &sub, w!("InitialTooltip"))
                    .map(|t| t.trim_matches(|c: char| c.is_whitespace() || c == '\u{202a}' || c == '\u{202c}').lines().next().unwrap_or("").to_string())
                    .filter(|t| !t.is_empty());
                let name = tooltip.unwrap_or_else(|| {
                    std::path::Path::new(&path)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
                let icon = reg_binary(HKEY_CURRENT_USER, &sub, w!("IconSnapshot"))
                    .filter(|b| b.starts_with(&[0x89, b'P', b'N', b'G']))
                    .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
                out.push(TrayApp { name, path, icon });
            }
            let _ = RegCloseKey(key);
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    }

    /* ---------------- Recycle Bin ---------------- */

    pub fn recycle_bin() -> RecycleBin {
        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            if SHQueryRecycleBinW(PCWSTR::null(), &mut info).is_ok() {
                return RecycleBin {
                    items: info.i64NumItems,
                    bytes: info.i64Size,
                };
            }
        }
        RecycleBin::default()
    }

    /// Windows asks for confirmation itself.
    pub fn empty_recycle_bin() -> Result<(), String> {
        unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), SHERB_NOSOUND) }.map_err(|e| e.message())
    }

    /* ---------------- power ---------------- */

    pub fn power(action: &str) -> Result<(), String> {
        let run = |args: &[&str]| {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("shutdown")
                .args(args)
                .creation_flags(0x0800_0000)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        };
        match action {
            "lock" => unsafe { LockWorkStation().map_err(|e| e.message()) },
            "sleep" => unsafe {
                if SetSuspendState(false, false, false) { Ok(()) } else { Err("Sleep isn't available".into()) }
            },
            "hibernate" => run(&["/h"]),
            "restart" => run(&["/r", "/t", "0"]),
            "shutdown" => run(&["/s", "/t", "0"]),
            "signout" => run(&["/l"]),
            other => Err(format!("Unknown power action: {other}")),
        }
    }
}
