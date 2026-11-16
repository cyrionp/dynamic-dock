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

let counter = Date.now();
export const newId = () => counter++;
