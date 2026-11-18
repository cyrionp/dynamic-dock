// Sample data for working on the dock in a browser (`npm run dev`), where
// there is no Windows to ask. Never used inside the app.

const COLORS = ["#4f8cff", "#ff6b5b", "#2ecc71", "#f5b041", "#a569bd", "#16a085", "#e84393", "#00b4d8"];

function letterIcon(key) {
  const name = key.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = COLORS[h % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".7"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="14" fill="url(#g)"/><text x="32" y="42" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="28" font-weight="600" fill="#fff">${name.charAt(0).toUpperCase()}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const w = (hwnd, exe, title, extra = {}) => ({
  hwnd,
  title,
  exe: `C:\\Program Files\\${exe}.exe`,
  appId: `c:\\program files\\${exe}.exe`.toLowerCase(),
  icon: `C:\\Program Files\\${exe}.exe`,
  minimized: false,
  active: false,
  ...extra,
});

let cpu = 18;

export const demo = {
  tasks: [
    w(1, "Firefox", "Dynamic Dock — GitHub — Mozilla Firefox", { active: true }),
    w(2, "Firefox", "Rust documentation — Mozilla Firefox"),
    w(3, "Code", "lib.rs — dynamic-dock — Visual Studio Code"),
    w(4, "Spotify", "Spotify Premium"),
    w(5, "Discord", "#general | Discord"),
    w(6, "Explorer", "Downloads", { minimized: true }),
  ],
  badges: { "c:\\program files\\discord.exe": "3", "c:\\program files\\spotify.exe": "•" },
  media: {
    hasSession: true,
    playing: true,
    title: "Midnight City",
    artist: "M83",
    source: "Spotify.exe",
    thumbnail: null,
    timeline: { positionMs: 72000, durationMs: 243000 },
    at: Date.now(),
  },
  audio: {
    available: true,
    devices: [
      { id: "a", name: "Speakers (Realtek Audio)", kind: "speakers", isDefault: false, bluetooth: false },
      { id: "b", name: "Headphones (AirPods Pro)", kind: "headphones", isDefault: true, bluetooth: true, battery: 80 },
    ],
  },
  volume: { level: 0.42, muted: false },
  stats() {
    cpu = Math.max(3, Math.min(97, cpu + (Math.random() - 0.5) * 18));
    return {
      cpu,
      memory: 47 + Math.random() * 3,
      memoryUsed: 7.6e9,
      memoryTotal: 16e9,
      drives: [
        { name: "C:", total: 512e9, free: 180e9 },
        { name: "D:", total: 1000e9, free: 610e9 },
      ],
      netDown: Math.random() * 2.4e6,
      netUp: Math.random() * 2e5,
      online: true,
      battery: 76,
      charging: false,
      uptimeSecs: 3 * 3600 + 25 * 60,
    };
  },
  icon: letterIcon,
  apps: ["Firefox", "Code", "Spotify", "Discord", "Steam", "Notion", "Figma", "Terminal", "Photoshop", "Slack", "Obsidian", "Word", "Excel", "Calculator"].map((n) => ({
    name: n,
    id: `C:\\Program Files\\${n}.exe`,
    path: `C:\\Program Files\\${n}.exe`,
  })),
  tray: [
    { name: "OneDrive", path: "C:\\OneDrive.exe", icon: null },
    { name: "Steam", path: "C:\\Steam.exe", icon: null },
    { name: "Discord", path: "C:\\Discord.exe", icon: null },
    { name: "NVIDIA", path: "C:\\NVIDIA.exe", icon: null },
  ],
};
