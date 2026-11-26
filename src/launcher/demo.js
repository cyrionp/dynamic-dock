// Made-up results for working on the launcher in a browser
// (`npx vite`, then open /launcher.html). Never used inside the app.

import { demo } from "../dock/demo.js";

const BUILTINS = [
  { kind: "setting", title: "Display settings", glyph: "gear", target: "ms-settings:display" },
  { kind: "setting", title: "Bluetooth and devices", glyph: "gear", target: "ms-settings:bluetooth" },
  { kind: "setting", title: "Windows Update", glyph: "gear", target: "ms-settings:windowsupdate" },
  { kind: "setting", title: "Device Manager", glyph: "cpu", target: "devmgmt.msc" },
  { kind: "command", title: "Lock the computer", glyph: "lock", target: "sys:lock" },
  { kind: "command", title: "Shut down", glyph: "power", target: "sys:shutdown", confirm: true },
  { kind: "command", title: "Empty the Recycle Bin", glyph: "trash", target: "sys:emptyBin", confirm: true },
  { kind: "command", title: "Hide or show the cat", glyph: "cat", target: "dock:toggleCat" },
  { kind: "command", title: "Dynamic Dock settings", glyph: "sliders", target: "dock:settings" },
];

const apps = () =>
  demo.apps.map((a) => ({
    kind: "app",
    key: `app:${a.id.toLowerCase()}`,
    title: a.name,
    icon: a.path,
    target: a.id,
    path: a.path,
    running: demo.tasks.some((w) => w.exe.toLowerCase() === a.path.toLowerCase()),
  }));

const windows = () =>
  demo.tasks.map((w) => ({
    kind: "window",
    key: `win:${w.appId}`,
    title: w.title,
    subtitle: w.exe.split("\\").pop().replace(/\.exe$/i, ""),
    icon: w.icon,
    hwnd: w.hwnd,
    running: true,
  }));

function score(q, title) {
  const t = title.toLowerCase();
  if (t.startsWith(q)) return 900;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 700;
  if (t.includes(q)) return 500;
  let i = 0;
  for (const c of t) if (c === q[i]) i++;
  return i === q.length && q.length > 2 ? 300 : 0;
}

function calc(text) {
  const expr = text.replace(/^=/, "").replace(/,/g, ".").replace(/[x×]/g, "*").replace(/÷/g, "/").replace(/\^/g, "**");
  if (!/^[\d\s+\-*/().%]+$/.test(expr) || !/\d/.test(expr) || !/[+\-*/%(]/.test(expr.slice(1))) return null;
  try {
    const v = Function(`"use strict"; return (${expr})`)();
    return Number.isFinite(v) ? String(Math.round(v * 1e10) / 1e10) : null;
  } catch {
    return null;
  }
}

export function demoSearch(text) {
  const raw = text.trim();
  if (!raw) {
    const suggested = apps()
      .slice(0, 4)
      .map((h) => ({ ...h, group: "suggested" }));
    return [...suggested, ...windows().map((h) => ({ ...h, group: "windows" }))];
  }
  const out = [];
  const v = calc(raw);
  if (v != null) out.push({ kind: "calc", key: "calc", title: v, subtitle: raw.replace(/^=/, ""), score: 5000 });
  if (raw.startsWith("=")) return out;
  const q = raw.replace(/^(>|w |\?)/, "").trim().toLowerCase();
  const pool = raw.startsWith(">") ? BUILTINS : raw.startsWith("w ") ? windows() : raw.startsWith("?") ? [] : [...apps(), ...BUILTINS, ...windows()];
  for (const h of pool) {
    const s = score(q, h.title);
    if (s || !q) out.push({ key: `${h.kind}:${h.target || h.title}`, ...h, score: s + (h.kind === "app" ? 60 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  if (q && !raw.startsWith("w ") && !raw.startsWith(">")) out.push({ kind: "web", key: "web", title: q, subtitle: "google", glyph: "globe" });
  return out.slice(0, 30);
}
