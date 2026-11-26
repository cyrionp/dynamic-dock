// The settings: their defaults, the catalog of everything that can go on a
// bar, and the clean-up that keeps a saved file usable after updates.
// Shared by the dock and the settings window; Rust only stores the file
// (and reads `shell` and `hotkeys` itself).

import { call, on, inTauri } from "./tauri.js";

export const MAX_BARS = 3;
export const ZONES = ["left", "center", "right"];

/* ---------- the catalog ---------- */

// Option types: bool, number (min/max/step/unit), select (choices),
// text, color, list (edited by its own editor in Settings).
// `group` sorts the catalog in Settings; `single` items may appear only once
// per bar.
export const CATALOG = {
  apps: {
    label: "Open apps",
    icon: "apps",
    group: "apps",
    blurb: "Pinned and running apps, like the taskbar",
    single: true,
    options: {
      showPinned: { type: "bool", label: "Show pinned apps", default: true },
      showRunning: { type: "bool", label: "Show running apps", default: true },
      group: { type: "bool", label: "Group windows of the same app", default: true },
      badges: { type: "bool", label: "Show notification counts", default: true },
      labels: { type: "bool", label: "Show window titles", default: false },
      labelWidth: { type: "number", label: "Title width", default: 140, min: 60, max: 320, step: 10, unit: "px" },
      multiClick: {
        type: "select",
        label: "Clicking an app with several windows",
        default: "list",
        choices: { list: "Show its windows", cycle: "Switch between them", last: "Bring the last one" },
      },
      previews: { type: "bool", label: "Show window previews in the list", default: true },
      pinned: { type: "list", label: "Pinned apps", default: [] },
    },
  },
  launcher: {
    label: "Shortcuts",
    icon: "rocket",
    group: "apps",
    blurb: "Your own files, folders, links and commands",
    options: {
      entries: { type: "list", label: "Shortcuts", default: [] },
    },
  },
  palette: {
    label: "Dynamic Launcher",
    icon: "sparkle",
    group: "apps",
    blurb: "Search apps, windows, settings and sums",
    single: true,
  },
  start: { label: "Start", icon: "start", group: "windows", blurb: "Opens the Start menu" },
  search: { label: "Search", icon: "search", group: "windows", blurb: "Windows search" },
  taskview: { label: "Task View", icon: "taskview", group: "windows", blurb: "Windows and desktops" },
  widgetsWin: { label: "Windows widgets", icon: "widgets", group: "windows", blurb: "The Windows widget board" },
  notifications: { label: "Notifications", icon: "bell", group: "windows", blurb: "Notification centre and calendar" },
  quicksettings: { label: "Quick settings", icon: "toggles", group: "windows", blurb: "Wi-Fi, Bluetooth, brightness…" },
  clipboard: { label: "Clipboard history", icon: "clipboard", group: "windows", blurb: "Win + V" },
  snip: { label: "Screenshot", icon: "scissors", group: "windows", blurb: "Snip part of the screen" },
  explorer: { label: "File Explorer", icon: "folder", group: "windows", blurb: "Opens File Explorer" },
  settingsWin: { label: "Windows Settings", icon: "gear", group: "windows", blurb: "Opens Windows Settings" },
  run: { label: "Run", icon: "terminal", group: "windows", blurb: "The Run box" },
  desktop: {
    label: "Show desktop",
    icon: "desktop",
    group: "windows",
    blurb: "Minimises everything, again to bring it back",
    options: { thin: { type: "bool", label: "Thin strip, like the taskbar", default: true } },
  },
  tray: { label: "Background apps", icon: "tray", group: "windows", blurb: "Apps with a tray icon" },
  clock: {
    label: "Clock",
    icon: "clock",
    group: "info",
    blurb: "Time and date, with a calendar",
    options: {
      hour24: { type: "bool", label: "24-hour clock", default: true },
      seconds: { type: "bool", label: "Show seconds", default: false },
      date: {
        type: "select",
        label: "Date",
        default: "short",
        choices: { none: "Hidden", short: "Short (16.11)", weekday: "With weekday", long: "Long" },
      },
      stacked: { type: "bool", label: "Date under the time", default: true },
      weekNumbers: { type: "bool", label: "Week numbers in the calendar", default: false },
    },
  },
  weather: {
    label: "Weather",
    icon: "weather",
    group: "info",
    blurb: "Now and the next days (Open-Meteo)",
    options: {
      city: { type: "text", label: "City", default: "", placeholder: "e.g. Istanbul" },
      unit: { type: "select", label: "Unit", default: "c", choices: { c: "°C", f: "°F" } },
      showText: { type: "bool", label: "Show the condition", default: false },
    },
  },
  media: {
    label: "Now playing",
    icon: "music",
    group: "media",
    blurb: "Music from any player, with its buttons",
    options: {
      cover: { type: "bool", label: "Show the cover", default: true },
      title: { type: "bool", label: "Show the title", default: true },
      width: { type: "number", label: "Title width", default: 180, min: 60, max: 400, step: 10, unit: "px" },
      controls: { type: "bool", label: "Show the buttons", default: true },
      skip: { type: "bool", label: "Show the skip buttons", default: true },
      skipSeconds: { type: "select", label: "Skip by", default: 15, choices: { 5: "5 seconds", 10: "10 seconds", 15: "15 seconds", 30: "30 seconds" } },
      hideIdle: { type: "bool", label: "Hide while nothing plays", default: false },
    },
  },
  volume: {
    label: "Volume",
    icon: "volume",
    group: "media",
    blurb: "Wheel to change, click for devices",
    options: { percent: { type: "bool", label: "Show the percentage", default: false } },
  },
  stats: {
    label: "System meters",
    icon: "cpu",
    group: "system",
    blurb: "Processor, memory and disk",
    options: {
      cpu: { type: "bool", label: "Processor", default: true },
      ram: { type: "bool", label: "Memory", default: true },
      disk: { type: "bool", label: "Disk", default: false },
      style: { type: "select", label: "Style", default: "ring", choices: { ring: "Rings", bar: "Bars", text: "Numbers" } },
      interval: { type: "number", label: "Refresh every", default: 2, min: 1, max: 30, step: 1, unit: "s" },
    },
  },
  network: {
    label: "Network speed",
    icon: "network",
    group: "system",
    blurb: "Download and upload right now",
    options: { up: { type: "bool", label: "Show upload too", default: true } },
  },
  battery: {
    label: "Battery",
    icon: "battery",
    group: "system",
    blurb: "Charge, hidden on desktops",
    options: { percent: { type: "bool", label: "Show the percentage", default: true } },
  },
  fps: {
    label: "FPS counter",
    icon: "gauge",
    group: "system",
    blurb: "Frames per second, also over a game",
  },
  recycle: { label: "Recycle Bin", icon: "trash", group: "system", blurb: "Open or empty it" },
  power: { label: "Power", icon: "power", group: "system", blurb: "Lock, sleep, restart, shut down" },
  stopwatch: { label: "Stopwatch", icon: "stopwatch", group: "productivity", blurb: "As many as you like" },
  countdown: {
    label: "Timer",
    icon: "timer",
    group: "productivity",
    blurb: "Countdowns that ring",
    options: { sound: { type: "bool", label: "Play a sound when done", default: true } },
  },
  notes: { label: "Notes", icon: "note", group: "productivity", blurb: "Quick notes, saved as you type" },
  todo: { label: "To-do", icon: "check", group: "productivity", blurb: "A short to-do list" },
  dockSettings: { label: "Dock settings", icon: "sliders", group: "dock", blurb: "Opens these settings" },
  barSwitcher: { label: "Bar switcher", icon: "dots", group: "dock", blurb: "Dots to switch bars" },
  separator: { label: "Separator", icon: "separator", group: "dock", blurb: "A thin line" },
  spacer: {
    label: "Space",
    icon: "space",
    group: "dock",
    blurb: "Empty room",
    options: { width: { type: "number", label: "Width", default: 16, min: 4, max: 200, step: 4, unit: "px" } },
  },
};

export const GROUPS = {
  apps: "Apps",
  windows: "Windows",
  info: "Time & weather",
  media: "Media",
  system: "System",
  productivity: "Productivity",
  dock: "Dock",
};

/* ---------- defaults ---------- */

let uidCounter = Date.now() % 1_000_000;
export const newUid = () => `i${(uidCounter++).toString(36)}`;

export function makeItem(type, opts = {}) {
  return { uid: newUid(), type, opts: { ...itemDefaults(type), ...opts } };
}

export function itemDefaults(type) {
  const out = {};
  for (const [key, o] of Object.entries(CATALOG[type]?.options ?? {})) {
    out[key] = structuredClone(o.default);
  }
  return out;
}

function defaultBars() {
  return [
    {
      id: "main",
      name: "Main",
      items: {
        left: [makeItem("start"), makeItem("palette"), makeItem("search"), makeItem("taskview")],
        center: [makeItem("apps")],
        right: [makeItem("tray"), makeItem("media", { width: 120 }), makeItem("volume"), makeItem("battery"), makeItem("clock"), makeItem("desktop")],
      },
    },
    {
      id: "focus",
      name: "Focus",
      items: {
        left: [makeItem("notes"), makeItem("todo")],
        center: [makeItem("countdown"), makeItem("stopwatch"), makeItem("media", { width: 220 })],
        right: [makeItem("weather"), makeItem("clock")],
      },
    },
    {
      id: "system",
      name: "System",
      items: {
        left: [makeItem("explorer"), makeItem("settingsWin"), makeItem("snip"), makeItem("clipboard")],
        center: [makeItem("stats", { disk: true }), makeItem("network"), makeItem("fps")],
        right: [makeItem("recycle"), makeItem("power"), makeItem("dockSettings"), makeItem("clock")],
      },
    },
  ];
}

export function defaults() {
  return {
    version: 1,
    lang: "auto",
    // The Windows taskbar's pins are copied in once, on the first start.
    pinsImported: false,
    // The Dynamic Launcher button is put next to Start once, for docks set
    // up before it existed.
    paletteAdded: false,
    shell: {
      monitors: "all",
      position: "bottom",
      barHeight: 52,
      margin: 6,
      autoHide: "off",
      hideOnFullscreen: true,
      popupSpace: 520,
    },
    hotkeys: {
      nextBar: "Ctrl+Alt+Right",
      previousBar: "Ctrl+Alt+Left",
      bar1: "Ctrl+Alt+1",
      bar2: "Ctrl+Alt+2",
      bar3: "Ctrl+Alt+3",
      toggleDock: "Ctrl+Alt+D",
      toggleCat: "Ctrl+Alt+K",
      toggleFps: "Ctrl+Alt+F",
      toggleFpsOverlay: "Ctrl+Alt+O",
      openLauncher: "Alt+Space",
    },
    // Dynamic Launcher (src/launcher, src-tauri/src/palette).
    palette: {
      enabled: true,
      // Keep its window made and hidden, so it opens at once.
      keepReady: true,
      windows: true,
      settings: true,
      commands: true,
      calc: true,
      web: true,
      webEngine: "google",
    },
    look: {
      theme: "midnight",
      // floating: one pill; split: a pill per zone; full: edge to edge.
      style: "split",
      radius: 16,
      iconSize: 32,
      opacity: 0.86,
      background: "",
      foreground: "",
      accent: "",
      border: true,
      shadow: true,
      font: "Segoe UI Variable Text",
      fontSize: 12,
      gap: 4,
      indicator: "dot",
      customCss: "",
    },
    motion: {
      magnify: true,
      magnifyScale: 1.45,
      magnifyRange: 2.5,
      bounce: true,
      switchStyle: "slide",
      speed: 1,
      hover: "lift",
      reduce: false,
    },
    behavior: {
      wheelSwitch: true,
      showBarDots: true,
      autoHideDelay: 500,
      returnToMain: 0,
      tooltips: true,
    },
    // The cat that lives on the dock (dock/cat.js). Every part can be
    // turned off on its own.
    cat: {
      enabled: true,
      name: "Tarçın",
      fur: "ginger",
      size: 1.2,
      roam: true,
      sleep: true,
      hover: true,
      play: true,
      bubbles: true,
      bubbleRate: "sometimes",
      sound: true,
      meowRate: "rare",
      purr: true,
      volume: 0.5,
      quietNight: true,
      system: true,
      breaks: "0",
    },
    updates: {
      // Look for a new release a little after start-up.
      auto: true,
    },
    bars: defaultBars(),
  };
}

/* ---------- clean-up ---------- */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Fills in what's missing from `fallback`, keeping known keys only. */
function merge(value, fallback) {
  if (!isObj(fallback)) return value === undefined || typeof value !== typeof fallback ? fallback : value;
  const out = {};
  for (const key of Object.keys(fallback)) out[key] = merge(isObj(value) ? value[key] : undefined, fallback[key]);
  return out;
}

function normaliseItem(item) {
  if (!isObj(item) || !CATALOG[item.type]) return null;
  const opts = {};
  const saved = isObj(item.opts) ? item.opts : {};
  for (const [key, o] of Object.entries(CATALOG[item.type].options ?? {})) {
    const v = saved[key];
    opts[key] = v === undefined || typeof v !== typeof o.default || Array.isArray(v) !== Array.isArray(o.default) ? structuredClone(o.default) : v;
  }
  return { uid: typeof item.uid === "string" ? item.uid : newUid(), type: item.type, opts };
}

function normaliseBar(bar, i) {
  const items = {};
  for (const zone of ZONES) {
    items[zone] = (Array.isArray(bar?.items?.[zone]) ? bar.items[zone] : []).map(normaliseItem).filter(Boolean);
  }
  return {
    id: typeof bar?.id === "string" ? bar.id : `bar${i + 1}`,
    name: typeof bar?.name === "string" ? bar.name : `Bar ${i + 1}`,
    items,
  };
}

/** True when some bar shows the open apps — one of them always must. */
export const hasApps = (bars) => bars.some((b) => ZONES.some((z) => b.items[z].some((i) => i.type === "apps")));

export function normalise(saved) {
  const base = defaults();
  if (!isObj(saved)) return base;
  const out = merge(saved, { ...base, bars: [] });
  const bars = (Array.isArray(saved.bars) ? saved.bars : []).slice(0, MAX_BARS).map(normaliseBar);
  out.bars = bars.length ? bars : base.bars;
  if (!hasApps(out.bars)) out.bars[0].items.center.unshift(makeItem("apps"));
  // Unique uids, even after hand edits.
  const seen = new Set();
  for (const bar of out.bars) for (const z of ZONES) for (const item of bar.items[z]) {
    if (seen.has(item.uid)) item.uid = newUid();
    seen.add(item.uid);
  }
  return out;
}

/* ---------- loading and saving ---------- */

// Outside the app (`npm run dev` in a browser) settings live in
// localStorage, so the pages can still be worked on.
const DEV_KEY = "dd.config";

export async function loadConfig() {
  if (!inTauri) {
    try {
      return normalise(JSON.parse(localStorage.getItem(DEV_KEY)));
    } catch {
      return defaults();
    }
  }
  try {
    return normalise(await call("get_config"));
  } catch {
    return defaults();
  }
}

export async function saveConfig(config) {
  const clean = normalise(config);
  if (!inTauri) {
    try {
      localStorage.setItem(DEV_KEY, JSON.stringify(clean));
      window.dispatchEvent(new CustomEvent("dd-config", { detail: clean }));
    } catch {
      // ignore
    }
    return clean;
  }
  await call("save_config", { value: clean });
  return clean;
}

/** Calls `fn(config)` whenever any window saves new settings. */
export function onConfigChange(fn) {
  if (!inTauri) {
    window.addEventListener("dd-config", (e) => fn(normalise(e.detail)));
    window.addEventListener("storage", (e) => {
      if (e.key === DEV_KEY) {
        try {
          fn(normalise(JSON.parse(e.newValue)));
        } catch {
          // ignore
        }
      }
    });
    return;
  }
  on("config://changed", (value) => fn(normalise(value)));
}
