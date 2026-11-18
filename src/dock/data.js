// Live data the widgets share: open windows, music, audio devices, volume,
// system meters and the dock's surroundings. Each source starts when its
// first widget subscribes; meters and volume stop again with the last one,
// so a bar without them costs nothing.

import { call, on, inTauri } from "../lib/tauri.js";
import { demo } from "./demo.js";

function source({ start, stop, initial }) {
  const subs = new Set();
  const s = {
    value: initial,
    started: false,
    set(v) {
      s.value = v;
      for (const fn of subs) fn(v);
    },
    subscribe(fn, opts) {
      subs.add(fn);
      if (!s.started) {
        s.started = true;
        start?.(s, opts);
      } else {
        s.update?.(opts, subs.size);
      }
      if (s.value !== undefined) fn(s.value);
      return () => {
        subs.delete(fn);
        if (!subs.size && stop) {
          s.started = false;
          stop(s);
        }
      };
    },
  };
  return s;
}

const listen = (event, s, map = (x) => x) => on(event, (v) => s.set(map(v)));

export const tasks = source({
  initial: [],
  start(s) {
    if (!inTauri) return s.set(demo.tasks);
    listen("tasks://update", s);
    call("tasks_list").then((v) => v && s.set(v)).catch(() => {});
  },
});

/** Notification counts on app icons: app id (lower case) → "3", "99+" or "•". */
export const badges = source({
  initial: {},
  start(s) {
    if (!inTauri) return s.set(demo.badges);
    listen("badges://update", s);
    call("badges_list").then((v) => v && s.set(v)).catch(() => {});
  },
});

// Pictures apps put on their taskbar button (unread counts): window → image.
export const overlays = source({
  initial: {},
  start(s) {
    if (!inTauri) return s.set(demo.overlays || {});
    listen("taskband://overlays", s);
    call("overlays_list").then((v) => v && s.set(v)).catch(() => {});
  },
});

export const media = source({
  initial: { hasSession: false },
  start(s) {
    if (!inTauri) return s.set(demo.media);
    listen("media://update", s);
    on("media://timeline", (timeline) => s.set({ ...s.value, timeline, at: Date.now() }));
    call("media_state").then((v) => v && s.set({ ...v, at: Date.now() })).catch(() => {});
  },
});

export const audio = source({
  initial: { devices: [] },
  start(s) {
    if (!inTauri) return s.set(demo.audio);
    listen("audio://devices", s);
    call("audio_devices").then((v) => v && s.set(v)).catch(() => {});
  },
});

export const env = source({
  initial: { fullscreen: false, overlapped: false, light: false, accent: "#4cc2ff", replaced: false, error: null },
  start(s) {
    if (!inTauri) return;
    listen("shell://env", s);
    call("shell_env").then((v) => v && s.set(v)).catch(() => {});
  },
});

// Volume has no event: read it every couple of seconds while shown, and
// right away after every change made here.
let volumeTimer = 0;
export const volume = source({
  initial: { level: 0.5, muted: false },
  start(s) {
    const read = () => (inTauri ? call("volume_get").then((v) => v && s.set(v)).catch(() => {}) : s.set(demo.volume));
    read();
    volumeTimer = setInterval(read, 2500);
  },
  stop() {
    clearInterval(volumeTimer);
  },
});

export async function changeVolume(args) {
  if (!inTauri) {
    const v = { ...volume.value };
    if (args.level != null) v.level = args.level;
    if (args.delta != null) v.level = Math.min(1, Math.max(0, v.level + args.delta));
    if (args.mute != null) v.muted = args.mute;
    return volume.set(v);
  }
  try {
    const v = await call("volume_change", args);
    if (v) volume.set(v);
  } catch {
    // ignore
  }
}

// System meters: the fastest interval any subscriber asked for.
const statIntervals = new Map();
let statKey = 0;
let demoStats = 0;
function applyStats() {
  const ms = statIntervals.size ? Math.min(...statIntervals.values()) : 0;
  if (inTauri) call("set_stats_interval", { ms }).catch(() => {});
  else {
    clearInterval(demoStats);
    if (ms) demoStats = setInterval(() => stats.set(demo.stats()), ms);
  }
}
export const stats = source({
  initial: undefined,
  start(s) {
    if (inTauri) listen("sys://stats", s);
    else s.set(demo.stats());
  },
});

/** Subscribe to the meters, asking for one reading every `ms`. */
export function subscribeStats(fn, ms = 2000) {
  const key = ++statKey;
  statIntervals.set(key, ms);
  applyStats();
  const off = stats.subscribe(fn);
  return () => {
    off();
    statIntervals.delete(key);
    applyStats();
  };
}

/* ---------- icons ---------- */

const iconCache = new Map();
let pending = new Map();
let flushQueued = false;

/** The icon for a path or `shell:AppsFolder\id`, as a data URL (or null). */
export function getIcon(key) {
  if (!key) return Promise.resolve(null);
  if (iconCache.has(key)) return iconCache.get(key);
  const p = new Promise((resolve) => pending.set(key, resolve));
  iconCache.set(key, p);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flushIcons);
  }
  return p;
}

async function flushIcons() {
  flushQueued = false;
  const batch = pending;
  pending = new Map();
  let result = {};
  if (inTauri) {
    try {
      result = (await call("get_icons", { keys: [...batch.keys()] })) ?? {};
    } catch {
      result = {};
    }
  } else {
    result = Object.fromEntries([...batch.keys()].map((k) => [k, demo.icon(k)]));
  }
  for (const [key, resolve] of batch) {
    const v = result[key] ?? null;
    iconCache.set(key, Promise.resolve(v));
    resolve(v);
  }
}

/** Fills `img` with the icon, falling back to an inline SVG. */
export function paintIcon(img, key, fallbackSvg) {
  getIcon(key).then((src) => {
    if (src) {
      img.src = src;
      img.hidden = false;
    } else if (fallbackSvg && img.parentElement) {
      img.insertAdjacentHTML("afterend", fallbackSvg);
      img.remove();
    }
  });
}
