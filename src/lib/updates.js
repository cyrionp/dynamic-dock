// Updates: asks the Tauri updater whether the latest GitHub Release is
// newer than this version, then downloads, installs and restarts. The dock
// checks by itself a little after start-up (when allowed in Settings);
// Settings › Updates can check any time.

import { inTauri } from "./tauri.js";

// idle | checking | latest | available | installing | error
let state = { status: "idle", version: "", next: "", progress: 0, error: "" };
let pending = null;
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export const updateState = () => state;

export function onUpdate(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export async function readVersion() {
  if (!inTauri) return set({ version: "dev" });
  const { getVersion } = await import("@tauri-apps/api/app");
  set({ version: await getVersion() });
}

export async function checkForUpdates() {
  if (!inTauri || state.status === "checking" || state.status === "installing") return state;
  set({ status: "checking", error: "" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    pending = await check();
    set(pending ? { status: "available", next: pending.version, notes: pending.body || "" } : { status: "latest" });
  } catch (err) {
    set({ status: "error", error: String(err?.message || err) });
  }
  return state;
}

/** The quiet check at start-up: a few tries in case the network is slow. */
export function checkOnLaunch({ delay = 10_000, retries = 3 } = {}) {
  if (!inTauri) return;
  let tries = 0;
  const attempt = async () => {
    await checkForUpdates();
    if (state.status === "error" && ++tries <= retries) setTimeout(attempt, 60_000);
  };
  setTimeout(attempt, delay);
}

export async function installUpdate() {
  if (!pending) await checkForUpdates();
  if (!pending || state.status === "installing") return;
  let total = 0;
  let done = 0;
  set({ status: "installing", progress: 0, error: "" });
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      if (e.event === "Progress") {
        done += e.data.chunkLength;
        if (total) set({ progress: Math.round((done / total) * 100) });
      }
    });
    // The installer normally closes the app itself; this covers the rest.
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    set({ status: "available", error: String(err?.message || err) });
  }
}
