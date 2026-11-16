// Small helpers shared by both pages.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 1536 → "1.5 KB". */
export function formatBytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`;
}

export const formatSpeed = (n) => `${formatBytes(n)}/s`;

const pad = (n) => String(n).padStart(2, "0");

/** 3723000 → "1:02:03", 63000 → "1:03". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Stopwatch: "1:02.3" under an hour, "1:02:03" above. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 100));
  const tenths = total % 10;
  const s = Math.floor(total / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}.${tenths}`;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Parses "#rgb", "#rrggbb" or "#rrggbbaa" into [r, g, b]. */
export function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** File name without folder and extension; "C:\\x\\Code.exe" → "Code". */
export function baseName(path) {
  const name = String(path || "").split(/[\\/]/).pop() || "";
  return name.replace(/\.(exe|lnk|url)$/i, "");
}

/** "chrome" → "Chrome", "msedge" → "Msedge". */
export const prettyName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
