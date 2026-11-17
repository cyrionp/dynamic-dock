// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `dynamic-dock --watchdog <pid>`: a tiny helper process the dock starts
    // for itself. It waits for the dock to end and, if it ended without
    // putting the Windows taskbar back (a crash, Task Manager), restores it.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--watchdog") {
        if let Some(pid) = args.get(i + 1).and_then(|p| p.parse::<u32>().ok()) {
            dynamic_dock_lib::watchdog(pid);
        }
        return;
    }
    // `dynamic-dock --restore-taskbar`: puts the Windows taskbar back and
    // exits, for the Start menu shortcut and for emergencies.
    if args.iter().any(|a| a == "--restore-taskbar") {
        dynamic_dock_lib::restore_taskbar_now();
        return;
    }
    dynamic_dock_lib::run()
}
