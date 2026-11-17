// The widgets' own data (notes, to-dos, timers) in localStorage: it stays
// on this computer and survives updates. Reads and writes never throw.

const PREFIX = "dd.data.";

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: keep running in memory
  }
}

/** Calls `fn` with the new value when another window (the dock on another
 * screen) saves `key`. */
export function watch(key, fn) {
  window.addEventListener("storage", (e) => {
    if (e.key !== PREFIX + key) return;
    try {
      fn(e.newValue === null ? null : JSON.parse(e.newValue));
    } catch {
      // ignore a broken value
    }
  });
}

let counter = Date.now();
export const newId = () => counter++;
