// Built-in looks. Each sets colours as CSS variables; the user can still
// override the background, text and accent colours, the opacity, corners,
// sizes and add their own CSS on top.
//
// bg: the bar (a colour or a gradient), pop: pop-ups, fg/muted: text,
// accent: highlights, line: borders, hover: hovered items.

export const THEMES = [
  {
    id: "system",
    name: "Windows",
    blurb: "Follows Windows' light or dark mode and accent colour",
    dark: { bg: "#202020", pop: "#2b2b2b", fg: "#ffffff", muted: "rgba(255,255,255,.66)", accent: "var(--sys-accent)", line: "rgba(255,255,255,.09)", hover: "rgba(255,255,255,.08)" },
    light: { bg: "#f3f3f3", pop: "#fbfbfb", fg: "#1a1a1a", muted: "rgba(0,0,0,.6)", accent: "var(--sys-accent)", line: "rgba(0,0,0,.08)", hover: "rgba(0,0,0,.05)" },
  },
  { id: "midnight", name: "Midnight", blurb: "Deep blue-black glass", bg: "#14161d", pop: "#1b1e27", fg: "#eef1f8", muted: "rgba(238,241,248,.6)", accent: "#7c9cff", line: "rgba(255,255,255,.08)", hover: "rgba(255,255,255,.08)" },
  { id: "snow", name: "Snow", blurb: "Bright, clean and soft", bg: "#f6f7fa", pop: "#ffffff", fg: "#1b1d23", muted: "rgba(27,29,35,.58)", accent: "#2f6fec", line: "rgba(0,0,0,.08)", hover: "rgba(0,0,0,.05)" },
  { id: "ocean", name: "Ocean", blurb: "Teal depths", bg: "linear-gradient(135deg,#0b2533,#0e3442)", pop: "#0f2e3b", fg: "#e6fbff", muted: "rgba(230,251,255,.62)", accent: "#36d1dc", line: "rgba(54,209,220,.18)", hover: "rgba(54,209,220,.12)" },
  { id: "sunset", name: "Sunset", blurb: "Warm plum and coral", bg: "linear-gradient(135deg,#2a1230,#4a1d2c)", pop: "#33172f", fg: "#fff1ec", muted: "rgba(255,241,236,.62)", accent: "#ff8a5c", line: "rgba(255,138,92,.2)", hover: "rgba(255,138,92,.12)" },
  { id: "forest", name: "Forest", blurb: "Calm moss green", bg: "#122019", pop: "#172a20", fg: "#eaf7ee", muted: "rgba(234,247,238,.6)", accent: "#6fd08c", line: "rgba(111,208,140,.16)", hover: "rgba(111,208,140,.1)" },
  { id: "neon", name: "Neon", blurb: "Synthwave glow", bg: "linear-gradient(135deg,#0d0b1a,#1a0b24)", pop: "#140f22", fg: "#f7ecff", muted: "rgba(247,236,255,.62)", accent: "#ff3df2", line: "rgba(255,61,242,.28)", hover: "rgba(255,61,242,.14)", glow: true },
  { id: "graphite", name: "Graphite", blurb: "Minimal monochrome", bg: "#1f1f21", pop: "#262628", fg: "#f2f2f2", muted: "rgba(242,242,242,.55)", accent: "#e8e8e8", line: "rgba(255,255,255,.1)", hover: "rgba(255,255,255,.07)" },
  { id: "sakura", name: "Sakura", blurb: "Blossom pink, light", bg: "#fff1f5", pop: "#fff8fa", fg: "#3a2430", muted: "rgba(58,36,48,.58)", accent: "#e0578a", line: "rgba(224,87,138,.16)", hover: "rgba(224,87,138,.08)" },
  { id: "amoled", name: "AMOLED", blurb: "Pure black, saves power on OLED", bg: "#000000", pop: "#0a0a0a", fg: "#ffffff", muted: "rgba(255,255,255,.55)", accent: "#4cc2ff", line: "rgba(255,255,255,.12)", hover: "rgba(255,255,255,.08)" },
  { id: "aurora", name: "Aurora", blurb: "Violet and green night sky", bg: "linear-gradient(120deg,#151030,#10283a 60%,#0f3a33)", pop: "#161a33", fg: "#f0f4ff", muted: "rgba(240,244,255,.6)", accent: "#8ef0b5", line: "rgba(142,240,181,.18)", hover: "rgba(142,240,181,.1)" },
];

export const themeById = (id) => THEMES.find((t) => t.id === id) ?? THEMES[1];

/** The colours to use: the theme (in Windows' mode for "system"). */
export function themeColors(theme, light) {
  if (theme.id === "system") return light ? theme.light : theme.dark;
  return theme;
}

/** Writes the look onto `root` as CSS variables. */
export function applyLook(root, look, env = {}) {
  const theme = themeById(look.theme);
  const c = themeColors(theme, env.light);
  const set = (k, v) => root.style.setProperty(k, v);
  set("--sys-accent", env.accent || "#4cc2ff");
  set("--bg", look.background || c.bg);
  set("--pop", look.background || c.pop);
  set("--fg", look.foreground || c.fg);
  set("--muted", look.foreground ? `color-mix(in srgb, ${look.foreground} 62%, transparent)` : c.muted);
  set("--accent", look.accent || c.accent);
  set("--line", c.line);
  set("--hover", c.hover);
  set("--bg-opacity", String(look.opacity));
  set("--radius", `${look.radius}px`);
  set("--icon", `${look.iconSize}px`);
  set("--gap", `${look.gap}px`);
  set("--font", `"${look.font}", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`);
  set("--font-size", `${look.fontSize}px`);
  root.dataset.theme = theme.id;
  root.dataset.light = String(theme.id === "system" ? Boolean(env.light) : ["snow", "sakura"].includes(theme.id));
  root.dataset.glow = String(Boolean(theme.glow));
  root.dataset.border = String(look.border);
  root.dataset.shadow = String(look.shadow);
  root.dataset.style = look.style;
  root.dataset.indicator = look.indicator;
}
