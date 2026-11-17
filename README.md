# Dynamic Dock

A fast, animated and fully customisable dock that replaces the Windows 11
taskbar. Written in Rust with [Tauri 2](https://tauri.app); the UI is plain
JavaScript and CSS, so the whole app stays small and light on RAM and CPU.

## Features

- **Replaces the taskbar.** The Windows taskbar is hidden and the dock
  reserves its space at the screen edge (bottom or top), like the taskbar did,
  so maximised windows stop above it. Turn this off in Settings to keep the
  taskbar and float the dock over it.
- **Three bars.** The dock holds up to three bars and switches between them
  with an animation: scroll on the dock, click the dots, use the bar switcher
  widget or the hotkeys (default `Ctrl+Alt+←/→` and `Ctrl+Alt+1/2/3`). You
  choose what goes on every bar, and each bar has left, middle and right zones.
  One bar always keeps the open programs.
- **Open programs and pins.** Running windows with their real icons, grouping
  per app, a window list on click, pinning, drag to reorder, close/minimise
  from the context menu and an animated bounce on launch.
- **30+ widgets:** apps, launcher, Start, search, Task View, Widgets,
  notifications, quick settings, clipboard, snipping tool, Explorer, Windows
  settings, Run, show desktop, tray apps, clock with calendar, weather, media
  player, volume with output device switcher, CPU/RAM/disk stats, network,
  battery, recycle bin, power menu, stopwatch, countdown timers, notes, to-do,
  dock settings, bar switcher, separator and spacer.
- **Looks.** 11 themes (including one that follows the Windows accent and
  light/dark mode), three bar styles (split pills, floating, full width),
  blur, radius, size, magnification on hover, animation speed and custom CSS.
- **Behaviour.** Auto-hide (off, smart: hide when a window touches the dock,
  always), hide on fullscreen apps and games, return to the main bar after a
  delay, and a global hotkey to show or hide the dock.
- **Updates.** The app checks the GitHub releases a few seconds after it starts
  and offers **Install** / **Later** right on the dock. **Settings → Updates**
  checks by hand and can turn the automatic check off.
- **English and Turkish** interface; export, import and reset of all settings.

## Getting the taskbar back

The dock restores the Windows taskbar when it exits, when it crashes, when
Windows shuts down and when its process is killed (a small watchdog process
does this). It also only hides the taskbar while the dock page is drawn and
answering, so a dock that fails to load or hangs gives the taskbar back.

If the taskbar still stays hidden, press **Win+R** and run:

```
"%LOCALAPPDATA%\Dynamic Dock\dynamic-dock.exe" --restore-taskbar
```

This ends every running Dynamic Dock process and shows the taskbar again.
Right-clicking the dock's tray icon and ticking **Show the Windows taskbar for
now** does the same without quitting.

## Logs

`%LOCALAPPDATA%\DynamicDock\dock.log` records what the dock did: taking or
giving back the taskbar, where it placed its window, full-screen changes,
Explorer restarts, crashes and page errors. Attach it when reporting a bug.

## Development

You need [Node.js](https://nodejs.org) 20+ and
[Rust](https://www.rust-lang.org/tools/install) with the MSVC toolchain on
Windows.

```
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build the installer into src-tauri/target/release/bundle/nsis
```

`npx vite` alone serves the UI in a browser with sample data, which is handy
for working on the look without Windows.

Layout:

- `src-tauri/src` – Rust: `shell.rs` (taskbar takeover, AppBar, fullscreen
  detection), `tasks.rs` (window tracking), `icons.rs`, `apps.rs`,
  `system.rs`, `volume.rs`, `media.rs`, `audio.rs`, `config.rs`, `lib.rs`.
- `src/dock` – the dock window and its widgets (`src/dock/widgets`).
- `src/settings` – the settings window.
- `src/lib` – shared config schema, themes, icons and translations.

## Releasing

Pushing a tag such as `v0.2.0` (or running it by hand) runs the Release
workflow: it builds the Windows setup `.exe` with that version, signs it for
the updater and publishes a GitHub Release with the installer and
`latest.json`. Installed docks read that file from the latest release.

One-time setup, since updates are signed:

1. Generate a key pair: `npx tauri signer generate -w ~/.tauri/dynamic-dock.key`
   (keep the private key safe; losing it means existing installs can't update).
   Without a local checkout, run it in a GitHub Codespace on this repository.
2. In the repository's **Settings → Secrets and variables → Actions**, add
   - secret `TAURI_SIGNING_PRIVATE_KEY`: the contents of the private key file,
   - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password (skip if none),
   - variable `TAURI_UPDATER_PUBKEY`: the contents of the `.pub` file.

Then release with `git tag v0.1.0 && git push origin v0.1.0`, or from the
browser: **Actions → Release → Run workflow**, and enter the version.

## Credits

Inspired by [OpenTaskbar](https://github.com/alztrk/opentaskbar). The media
and audio device code comes from
[Dynamic Peninsula](https://github.com/cyrionp/dynamic-peninsula).

## License

Licensed under either of

- Apache License, Version 2.0 ([`LICENSE-APACHE`](LICENSE-APACHE))
- MIT license ([`LICENSE-MIT`](LICENSE-MIT))

at your option.
