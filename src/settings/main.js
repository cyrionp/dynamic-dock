// The settings window. Every change is saved at once; the dock hears about
// it and redraws. Nothing here needs a "Save" button.

import "./settings.css";
import { call, inTauri } from "../lib/tauri.js";
import {
  loadConfig,
  saveConfig,
  onConfigChange,
  defaults,
  normalise,
  CATALOG,
  GROUPS,
  ZONES,
  MAX_BARS,
  makeItem,
  hasApps,
  newUid,
} from "../lib/config.js";
import { THEMES, themeColors } from "../lib/themes.js";
import { setLang, t, LANGUAGES } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { escapeHtml, debounce, baseName } from "../lib/util.js";
import { onUpdate, checkForUpdates, installUpdate, readVersion } from "../lib/updates.js";
import { demo } from "../dock/demo.js";

const app = document.getElementById("app");
let config = null;
let section = "general";
let openBar = 0;
let expanded = new Set(); // item uids whose options are open
let autostart = null;

/* ---------- reading and writing by path ---------- */

const get = (path) => path.split(".").reduce((o, k) => o?.[k], config);

function set(path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], config);
  obj[last] = value;
}

const persist = debounce(async () => {
  config = await saveConfig(config);
  flash();
}, 200);

function changed({ rerender = false } = {}) {
  persist();
  if (rerender) render();
}

let flashTimer = 0;
function flash() {
  const el = document.querySelector(".saved");
  if (!el) return;
  el.classList.add("is-on");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("is-on"), 1200);
}

/* ---------- controls ---------- */

const row = (label, control, hint = "") => `<div class="row"><div class="row-text"><div class="row-label">${label}</div>${hint ? `<div class="row-hint">${hint}</div>` : ""}</div><div class="row-ctl">${control}</div></div>`;

const toggle = (path, value = get(path)) => `<label class="toggle"><input type="checkbox" data-path="${path}" ${value ? "checked" : ""} /><span></span></label>`;

const select = (path, choices, value = get(path)) =>
  `<select class="select" data-path="${path}">${Object.entries(choices)
    .map(([k, v]) => `<option value="${escapeHtml(k)}" ${String(value) === k ? "selected" : ""}>${escapeHtml(t(v))}</option>`)
    .join("")}</select>`;

const range = (path, min, max, step, unit = "", value = get(path)) =>
  `<div class="range-wrap"><input class="range" type="range" data-path="${path}" data-num min="${min}" max="${max}" step="${step}" value="${value}" /><output>${fmt(value, step)}${unit}</output></div>`;

const fmt = (v, step) => (step < 1 ? Number(v).toFixed(step < 0.1 ? 2 : 1) : String(v));

const text = (path, placeholder = "", value = get(path)) => `<input class="input" data-path="${path}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />`;

const color = (path, fallback, value = get(path)) =>
  `<div class="color-wrap"><input type="color" data-path="${path}" value="${value || fallback}" />
   <button class="ghost ${value ? "" : "is-hidden"}" data-reset="${path}">${t("Theme default")}</button></div>`;

/* ---------- sections ---------- */

const SECTIONS = [
  ["general", "sliders", "General"],
  ["look", "palette", "Appearance"],
  ["motion", "sparkle", "Animations"],
  ["bars", "layers", "Bars & widgets"],
  ["hotkeys", "keyboard", "Shortcuts"],
  ["updates", "download", "Updates & about"],
];

function general() {
  return `<h2>${t("General")}</h2>
    <div class="card">
      ${row(t("Replace the Windows taskbar"), toggle("shell.replaceTaskbar"), t("Hides the Windows taskbar and puts the dock in its place. It always comes back when the dock closes."))}
      ${row(t("Start with Windows"), `<label class="toggle"><input type="checkbox" data-autostart ${autostart ? "checked" : ""} ${autostart == null ? "disabled" : ""} /><span></span></label>`)}
      ${row(t("Language"), select("lang", Object.fromEntries(LANGUAGES.map((l) => [l.id, l.label]))))}
    </div>
    <h3>${t("Place")}</h3>
    <div class="card">
      ${row(t("Screen edge"), select("shell.position", { bottom: "Bottom", top: "Top" }))}
      ${row(t("Distance from the edge"), range("shell.margin", 0, 24, 1, " px"))}
      ${row(t("Bar height"), range("shell.barHeight", 36, 80, 1, " px"))}
    </div>
    <h3>${t("Hiding")}</h3>
    <div class="card">
      ${row(t("Auto-hide"), select("shell.autoHide", { off: "Never", smart: "When a window touches it", always: "Always, show at the screen edge" }))}
      ${row(t("Delay before hiding"), range("behavior.autoHideDelay", 0, 2000, 50, " ms"))}
      ${row(t("Step aside for full-screen apps"), toggle("shell.hideOnFullscreen"), t("Games, videos and presentations get the whole screen."))}
    </div>
    <h3>${t("Using the dock")}</h3>
    <div class="card">
      ${row(t("Mouse wheel switches bars"), toggle("behavior.wheelSwitch"), t("Over an empty part of the dock."))}
      ${row(t("Show bar dots"), toggle("behavior.showBarDots"))}
      ${row(t("Go back to the first bar after"), range("behavior.returnToMain", 0, 120, 5, " s"), t("0 keeps the bar you picked."))}
      ${row(t("Tooltips"), toggle("behavior.tooltips"))}
    </div>`;
}

function themeCard(th) {
  const c = themeColors(th, false);
  const on = config.look.theme === th.id;
  return `<button class="theme ${on ? "is-on" : ""}" data-theme="${th.id}">
      <span class="theme-prev" style="background:${th.id === "system" ? "linear-gradient(90deg,#202020 50%,#f3f3f3 50%)" : c.bg}">
        <i style="background:${c.accent === "var(--sys-accent)" ? "#4cc2ff" : c.accent}"></i><i style="background:${c.fg};opacity:.7"></i><i style="background:${c.fg};opacity:.4"></i>
      </span>
      <b>${escapeHtml(th.name)}</b><small>${escapeHtml(t(th.blurb))}</small></button>`;
}

function look() {
  const th = THEMES.find((x) => x.id === config.look.theme) ?? THEMES[1];
  const c = themeColors(th, false);
  const solid = (v) => (/^#/.test(v) ? v : "#202020");
  return `<h2>${t("Appearance")}</h2>
    <div class="themes">${THEMES.map(themeCard).join("")}</div>
    <h3>${t("Shape")}</h3>
    <div class="card">
      ${row(t("Style"), select("look.style", { split: "Three islands", floating: "One floating bar", full: "Edge to edge, like the taskbar" }))}
      ${row(t("Corner roundness"), range("look.radius", 0, 30, 1, " px"))}
      ${row(t("Icon size"), range("look.iconSize", 20, 56, 1, " px"))}
      ${row(t("Space between items"), range("look.gap", 0, 16, 1, " px"))}
      ${row(t("Running indicator"), select("look.indicator", { dot: "Dots", line: "Line", none: "None" }))}
    </div>
    <h3>${t("Colours")}</h3>
    <div class="card">
      ${row(t("Background opacity"), range("look.opacity", 0, 1, 0.01))}
      ${row(t("Background"), color("look.background", solid(c.bg)))}
      ${row(t("Text and icons"), color("look.foreground", solid(c.fg)))}
      ${row(t("Accent"), color("look.accent", solid(c.accent)))}
      ${row(t("Border"), toggle("look.border"))}
      ${row(t("Shadow"), toggle("look.shadow"))}
    </div>
    <h3>${t("Text")}</h3>
    <div class="card">
      ${row(t("Font"), text("look.font", "Segoe UI Variable Text"))}
      ${row(t("Text size"), range("look.fontSize", 10, 16, 1, " px"))}
    </div>
    <h3>${t("Your own CSS")}</h3>
    <div class="card">
      <p class="row-hint">${t("For complete freedom: anything here is added to the dock's styles. Example: .pill { backdrop-filter: none; }")}</p>
      <textarea class="code" data-path="look.customCss" spellcheck="false" placeholder=".cell:hover { transform: rotate(-6deg); }">${escapeHtml(config.look.customCss)}</textarea>
    </div>`;
}

function motion() {
  return `<h2>${t("Animations")}</h2>
    <div class="card">
      ${row(t("Magnify icons under the pointer"), toggle("motion.magnify"))}
      ${row(t("Magnification"), range("motion.magnifyScale", 1.1, 2.2, 0.05, "×"))}
      ${row(t("Magnification reach"), range("motion.magnifyRange", 1, 5, 0.5, ""), t("How many neighbouring icons grow along."))}
      ${row(t("Bounce while an app starts"), toggle("motion.bounce"))}
      ${row(t("Hover effect"), select("motion.hover", { lift: "Lift", glow: "Glow", none: "None" }))}
    </div>
    <div class="card">
      ${row(t("Switching bars"), select("motion.switchStyle", { slide: "Slide", fade: "Fade", zoom: "Zoom", flip: "Flip", rise: "Rise", none: "None" }))}
      ${row(t("Animation speed"), range("motion.speed", 0.5, 2, 0.1, "×"), t("Higher is faster."))}
      ${row(t("Reduce motion"), toggle("motion.reduce"), t("Turns animations off almost entirely."))}
    </div>`;
}

/* ---------- bars ---------- */

function itemRow(item, zone, index, bar) {
  const meta = CATALOG[item.type];
  const opts = Object.entries(meta.options ?? {});
  const open = expanded.has(item.uid);
  const appsCount = config.bars.reduce((n, b) => n + ZONES.reduce((m, z) => m + b.items[z].filter((x) => x.type === "apps").length, 0), 0);
  const locked = item.type === "apps" && appsCount <= 1;
  const list = bar.items[zone];
  return `<div class="item ${open ? "is-open" : ""}" data-uid="${item.uid}" data-zone="${zone}" draggable="true">
      <div class="item-head">
        <span class="item-drag">${icon("drag")}</span>
        <span class="item-ic">${icon(meta.icon)}</span>
        <span class="item-name">${escapeHtml(t(meta.label))}${item.type === "apps" && item.opts.pinned.length ? ` <em>${t("{n} pinned", { n: item.opts.pinned.length })}</em>` : ""}</span>
        <span class="item-btns">
          <button class="icon-btn" data-move="-1" ${index === 0 ? "disabled" : ""} title="${t("Move left")}">${icon("left")}</button>
          <button class="icon-btn" data-move="1" ${index === list.length - 1 ? "disabled" : ""} title="${t("Move right")}">${icon("right")}</button>
          ${opts.length ? `<button class="icon-btn ${open ? "is-on" : ""}" data-expand title="${t("Options")}">${icon("gear")}</button>` : ""}
          <button class="icon-btn" data-remove ${locked ? `disabled title="${t("One bar must always show the open apps.")}"` : `title="${t("Remove")}"`}>${icon("close")}</button>
        </span>
      </div>
      ${open ? `<div class="item-opts">${opts.map(([k, o]) => optionRow(item, k, o)).join("")}</div>` : ""}
    </div>`;
}

function optionRow(item, key, o) {
  const path = `@${item.uid}.${key}`;
  const v = item.opts[key];
  switch (o.type) {
    case "bool":
      return row(t(o.label), toggle(path, v));
    case "number":
      return row(t(o.label), range(path, o.min, o.max, o.step, o.unit ? ` ${o.unit}` : "", v));
    case "select":
      return row(t(o.label), select(path, o.choices, v));
    case "text":
      return row(t(o.label), text(path, o.placeholder ? t(o.placeholder) : "", v));
    case "list":
      return key === "pinned" ? pinnedEditor(item) : launcherEditor(item);
    default:
      return "";
  }
}

function pinnedEditor(item) {
  const pins = item.opts.pinned;
  return `<div class="list-editor">
      <div class="row-label">${t("Pinned apps")}</div>
      ${pins.length ? "" : `<p class="row-hint">${t("Nothing pinned yet. Add apps here, or right-click a running app on the dock and choose “Pin to the dock”.")}</p>`}
      ${pins
        .map(
          (p, i) => `<div class="list-row" data-pin="${i}"><span>${escapeHtml(p.name || baseName(p.path || p.id))}</span><small>${escapeHtml(p.path || p.id)}</small>
          <button class="icon-btn" data-pin-move="-1" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
          <button class="icon-btn" data-pin-move="1" ${i === pins.length - 1 ? "disabled" : ""}>${icon("down")}</button>
          <button class="icon-btn" data-pin-del>${icon("close")}</button></div>`
        )
        .join("")}
      <div class="list-add"><button class="ghost" data-pick-app="${item.uid}">${icon("plus")} ${t("Add from installed apps")}</button>
      <button class="ghost" data-pin-path="${item.uid}">${icon("file")} ${t("Add a program by path")}</button></div>
    </div>`;
}

function launcherEditor(item) {
  const entries = item.opts.entries;
  return `<div class="list-editor">
      <div class="row-label">${t("Shortcuts")}</div>
      <p class="row-hint">${t("A program, file, folder, web address or Windows location (shell:Downloads, ms-settings:display…).")}</p>
      ${entries
        .map(
          (e, i) => `<div class="list-row is-edit" data-entry="${i}">
          <input class="input" data-entry-field="name" value="${escapeHtml(e.name || "")}" placeholder="${t("Name")}" />
          <input class="input is-wide" data-entry-field="target" value="${escapeHtml(e.target || "")}" placeholder="C:\\…, https://…" />
          <input class="input" data-entry-field="args" value="${escapeHtml(e.args || "")}" placeholder="${t("Arguments")}" />
          <button class="icon-btn" data-entry-del>${icon("close")}</button></div>`
        )
        .join("")}
      <div class="list-add"><button class="ghost" data-entry-add="${item.uid}">${icon("plus")} ${t("Add shortcut")}</button>
      <button class="ghost" data-pick-app-launcher="${item.uid}">${icon("apps")} ${t("Add from installed apps")}</button></div>
    </div>`;
}

function bars() {
  const bar = config.bars[openBar] ?? config.bars[0];
  const tabs = config.bars
    .map((b, i) => `<button class="tab ${i === openBar ? "is-on" : ""}" data-bar-tab="${i}">${escapeHtml(b.name)}</button>`)
    .join("");
  return `<h2>${t("Bars & widgets")}</h2>
    <p class="lead">${t("The dock has up to three bars. Switch between them with the mouse wheel, the dots or the shortcuts. Each bar has a left, middle and right part; put anything anywhere. One bar always shows the open apps.")}</p>
    <div class="tabs">${tabs}${config.bars.length < MAX_BARS ? `<button class="tab is-add" data-bar-add>${icon("plus")} ${t("Add bar")}</button>` : ""}</div>
    <div class="card bar-card">
      ${row(t("Name"), `<input class="input" data-bar-name value="${escapeHtml(bar.name)}" />`)}
      <div class="bar-tools">
        <button class="ghost" data-bar-move="-1" ${openBar === 0 ? "disabled" : ""}>${icon("left")} ${t("Move earlier")}</button>
        <button class="ghost" data-bar-move="1" ${openBar === config.bars.length - 1 ? "disabled" : ""}>${t("Move later")} ${icon("right")}</button>
        <button class="ghost" data-bar-dup ${config.bars.length >= MAX_BARS ? "disabled" : ""}>${icon("layers")} ${t("Duplicate")}</button>
        <button class="ghost is-danger" data-bar-del ${config.bars.length <= 1 ? "disabled" : ""}>${icon("trash")} ${t("Delete bar")}</button>
      </div>
    </div>
    <div class="zones">${ZONES.map(
      (z) => `<div class="zone-col" data-drop="${z}">
        <div class="zone-head">${t({ left: "Left", center: "Middle", right: "Right" }[z])}</div>
        ${bar.items[z].map((item, i) => itemRow(item, z, i, bar)).join("")}
        <button class="add-item" data-add-to="${z}">${icon("plus")} ${t("Add")}</button>
      </div>`
    ).join("")}</div>`;
}

function hotkeys() {
  const hk = (path, label) => row(label, `<div class="hk"><input class="input hk-input" data-hotkey="${path}" value="${escapeHtml(get(path))}" placeholder="${t("Click, then press keys")}" readonly /><button class="icon-btn" data-hk-clear="${path}" title="${t("Clear")}">${icon("close")}</button></div>`);
  return `<h2>${t("Shortcuts")}</h2>
    <p class="lead">${t("Work anywhere in Windows. Click a box and press the keys you want; Backspace clears it.")}</p>
    <div class="card">
      ${hk("hotkeys.nextBar", t("Next bar"))}
      ${hk("hotkeys.previousBar", t("Previous bar"))}
      ${hk("hotkeys.bar1", t("First bar"))}
      ${hk("hotkeys.bar2", t("Second bar"))}
      ${hk("hotkeys.bar3", t("Third bar"))}
      ${hk("hotkeys.toggleDock", t("Hide or show the dock"))}
    </div>`;
}

let update = { status: "idle", version: "" };
function updates() {
  const s = update;
  const status = {
    idle: "",
    checking: t("Checking…"),
    latest: t("You're on the latest version."),
    available: t("Version {version} is available.", { version: s.next }),
    installing: t("Downloading… {percent}%", { percent: s.progress }),
    error: t("Couldn't check for updates: {error}", { error: s.error }),
  }[s.status];
  return `<h2>${t("Updates & about")}</h2>
    <div class="card">
      ${row(t("Version"), `<b>${escapeHtml(s.version || "…")}</b>`)}
      ${row(t("Check for updates at start-up"), toggle("updates.auto"))}
      <div class="update-line"><span>${escapeHtml(status || "")}${s.error && s.status === "available" ? `<br><small>${escapeHtml(s.error)}</small>` : ""}</span>
        ${s.status === "available" ? `<button class="primary" data-install>${t("Install and restart")}</button>` : `<button class="ghost" data-check ${s.status === "checking" || !inTauri ? "disabled" : ""}>${t("Check now")}</button>`}</div>
      ${inTauri ? "" : `<p class="row-hint">${t("Updates work in the desktop app only.")}</p>`}
    </div>
    <h3>${t("Your settings")}</h3>
    <div class="card">
      <div class="bar-tools">
        <button class="ghost" data-export>${icon("download")} ${t("Export to a file")}</button>
        <button class="ghost" data-import>${icon("file")} ${t("Import from a file")}</button>
        <button class="ghost is-danger" data-reset-all>${icon("reset")} ${t("Reset everything")}</button>
      </div>
    </div>
    <h3>${t("If something goes wrong")}</h3>
    <div class="card">
      ${row(t("Show the Windows taskbar for now"), `<button class="ghost" data-pause>${t("Show it")}</button>`, t("Until the dock restarts. The tray icon has the same switch."))}
      ${row(t("Quit Dynamic Dock"), `<button class="ghost is-danger" data-quit>${t("Quit")}</button>`, t("The Windows taskbar comes back right away."))}
    </div>
    <p class="about">Dynamic Dock · ${t("Open source, MIT or Apache-2.0")} · <a href="https://github.com/cyrionp/dynamic-dock" target="_blank">github.com/cyrionp/dynamic-dock</a></p>`;
}

/* ---------- page ---------- */

function render() {
  const scroll = document.querySelector(".content")?.scrollTop ?? 0;
  const body = { general, look, motion, bars, hotkeys, updates }[section]();
  app.innerHTML = `<nav class="side">
      <div class="brand"><span class="logo"></span><div><b>Dynamic Dock</b><small>${t("Settings")}</small></div></div>
      ${SECTIONS.map(([id, ic, label]) => `<button class="nav ${id === section ? "is-on" : ""}" data-section="${id}">${icon(ic)}<span>${t(label)}</span></button>`).join("")}
      <span class="saved">${icon("check")} ${t("Saved")}</span>
    </nav>
    <main class="content">${body}</main>`;
  const content = document.querySelector(".content");
  content.scrollTop = scroll;
}

function findItem(uid) {
  for (const bar of config.bars) for (const z of ZONES) {
    const i = bar.items[z].findIndex((x) => x.uid === uid);
    if (i >= 0) return { bar, zone: z, index: i, item: bar.items[z][i] };
  }
  return null;
}

function setByPath(path, value) {
  if (path.startsWith("@")) {
    const [uid, key] = path.slice(1).split(".");
    const found = findItem(uid);
    if (found) found.item.opts[key] = value;
  } else set(path, value);
}

/* ---------- pickers (modal) ---------- */

function modal(title, bodyHtml, onClick, onInput) {
  const wrap = document.createElement("div");
  wrap.className = "modal-wrap";
  wrap.innerHTML = `<div class="modal"><div class="modal-head"><b>${title}</b><button class="icon-btn" data-close>${icon("close")}</button></div><div class="modal-body">${bodyHtml}</div></div>`;
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("is-on"));
  const close = () => {
    wrap.classList.remove("is-on");
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) return close();
    onClick?.(e, close, wrap);
  });
  wrap.addEventListener("input", (e) => onInput?.(e, wrap));
  return wrap;
}

function catalogPicker(zone) {
  const bar = config.bars[openBar];
  const groups = Object.entries(GROUPS)
    .map(([g, label]) => {
      const items = Object.entries(CATALOG).filter(([, m]) => m.group === g);
      return `<div class="cat-group"><div class="cat-title">${t(label)}</div><div class="cat-grid">${items
        .map(([id, m]) => {
          const taken = m.single && ZONES.some((z) => bar.items[z].some((x) => x.type === id));
          return `<button class="cat" data-type="${id}" ${taken ? "disabled" : ""}>${icon(m.icon)}<b>${escapeHtml(t(m.label))}</b><small>${escapeHtml(t(m.blurb))}</small></button>`;
        })
        .join("")}</div></div>`;
    })
    .join("");
  modal(t("Add to the bar"), `<input class="input cat-search" placeholder="${t("Search widgets…")}" />${groups}`, (e, close) => {
    const c = e.target.closest("[data-type]");
    if (!c) return;
    const item = makeItem(c.dataset.type);
    bar.items[zone].push(item);
    expanded.add(item.uid);
    close();
    changed({ rerender: true });
  }, (e, wrap) => {
    if (!e.target.matches(".cat-search")) return;
    const q = e.target.value.toLowerCase();
    wrap.querySelectorAll(".cat").forEach((c) => (c.hidden = q && !c.textContent.toLowerCase().includes(q)));
  });
  setTimeout(() => document.querySelector(".cat-search")?.focus(), 50);
}

async function appPicker(onPick) {
  const wrap = modal(t("Installed apps"), `<input class="input cat-search" placeholder="${t("Search apps…")}" /><div class="app-list"><p class="row-hint">${t("Loading…")}</p></div>`, (e, close) => {
    const b = e.target.closest("[data-app]");
    if (!b) return;
    onPick(list[Number(b.dataset.app)]);
    close();
  }, (e, w) => {
    const q = e.target.value.toLowerCase();
    w.querySelectorAll("[data-app]").forEach((c) => (c.hidden = q && !c.textContent.toLowerCase().includes(q)));
  });
  let list = [];
  try {
    list = inTauri ? await call("installed_apps") : demo.apps;
  } catch {
    list = [];
  }
  wrap.querySelector(".app-list").innerHTML = list.length
    ? list.map((a, i) => `<button class="app-row" data-app="${i}"><b>${escapeHtml(a.name)}</b><small>${escapeHtml(a.path || a.id)}</small></button>`).join("")
    : `<p class="row-hint">${t("No apps found.")}</p>`;
  setTimeout(() => wrap.querySelector(".cat-search")?.focus(), 50);
}

function pathPrompt(title, onDone) {
  modal(title, `<form class="path-form"><input class="input" name="p" placeholder="C:\\Program Files\\App\\app.exe" /><button class="primary">${t("Add")}</button></form>`);
  const form = document.querySelector(".path-form");
  form.p.focus();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = form.p.value.trim().replace(/^"|"$/g, "");
    document.querySelector(".modal-wrap [data-close]")?.click();
    if (v) onDone(v);
  });
}

/* ---------- events ---------- */

app.addEventListener("click", async (e) => {
  const el = e.target.closest("button, [data-theme]");
  if (!el) return;
  const d = el.dataset;
  if (d.section) {
    section = d.section;
    try {
      localStorage.setItem("dd.settings.section", section);
    } catch {
      // ignore
    }
    return render();
  }
  if (d.theme) {
    config.look.theme = d.theme;
    return changed({ rerender: true });
  }
  if (d.reset) {
    setByPath(d.reset, "");
    return changed({ rerender: true });
  }

  /* bars */
  const bar = config.bars[openBar];
  if (d.barTab != null) {
    openBar = Number(d.barTab);
    return render();
  }
  if ("barAdd" in d) {
    config.bars.push({ id: newUid(), name: t("Bar {n}", { n: config.bars.length + 1 }), items: { left: [], center: [makeItem("clock")], right: [] } });
    openBar = config.bars.length - 1;
    return changed({ rerender: true });
  }
  if ("barDup" in d) {
    const copy = structuredClone(bar);
    copy.id = newUid();
    copy.name = `${bar.name} 2`;
    for (const z of ZONES) copy.items[z] = copy.items[z].filter((x) => x.type !== "apps").map((x) => ({ ...x, uid: newUid() }));
    config.bars.splice(openBar + 1, 0, copy);
    openBar += 1;
    return changed({ rerender: true });
  }
  if ("barDel" in d) {
    const rest = config.bars.filter((_, i) => i !== openBar);
    if (!hasApps(rest)) return alertBox(t("This bar shows the open apps. Move them to another bar first."));
    config.bars = rest;
    openBar = Math.max(0, openBar - 1);
    return changed({ rerender: true });
  }
  if (d.barMove) {
    const to = openBar + Number(d.barMove);
    const [b] = config.bars.splice(openBar, 1);
    config.bars.splice(to, 0, b);
    openBar = to;
    return changed({ rerender: true });
  }
  if (d.addTo) return catalogPicker(d.addTo);

  const itemEl = el.closest("[data-uid]");
  if (itemEl) {
    const found = findItem(itemEl.dataset.uid);
    if (!found) return;
    const list = found.bar.items[found.zone];
    if (d.move) {
      const to = found.index + Number(d.move);
      list.splice(found.index, 1);
      list.splice(to, 0, found.item);
      return changed({ rerender: true });
    }
    if ("expand" in d) {
      if (expanded.has(found.item.uid)) expanded.delete(found.item.uid);
      else expanded.add(found.item.uid);
      return render();
    }
    if ("remove" in d) {
      list.splice(found.index, 1);
      if (!hasApps(config.bars)) {
        list.splice(found.index, 0, found.item);
        return alertBox(t("One bar must always show the open apps."));
      }
      return changed({ rerender: true });
    }
    if (d.pinMove || "pinDel" in d) {
      const i = Number(el.closest("[data-pin]").dataset.pin);
      const pins = found.item.opts.pinned;
      if ("pinDel" in d) pins.splice(i, 1);
      else {
        const [p] = pins.splice(i, 1);
        pins.splice(i + Number(d.pinMove), 0, p);
      }
      return changed({ rerender: true });
    }
    if (d.pickApp) {
      return appPicker((a) => {
        found.item.opts.pinned.push({ kind: "app", id: a.id, path: a.path, name: a.name });
        changed({ rerender: true });
      });
    }
    if (d.pinPath) {
      return pathPrompt(t("Add a program by path"), (p) => {
        found.item.opts.pinned.push({ kind: "file", id: p, path: p, name: baseName(p) });
        changed({ rerender: true });
      });
    }
    if (d.entryAdd) {
      found.item.opts.entries.push({ name: "", target: "", args: "" });
      return changed({ rerender: true });
    }
    if (d.pickAppLauncher) {
      return appPicker((a) => {
        found.item.opts.entries.push({ name: a.name, target: a.path || `shell:AppsFolder\\${a.id}`, args: "" });
        changed({ rerender: true });
      });
    }
    if ("entryDel" in d) {
      found.item.opts.entries.splice(Number(el.closest("[data-entry]").dataset.entry), 1);
      return changed({ rerender: true });
    }
  }

  /* hotkeys */
  if (d.hkClear) {
    set(d.hkClear, "");
    return changed({ rerender: true });
  }

  /* updates & about */
  if ("check" in d) return checkForUpdates();
  if ("install" in d) return installUpdate();
  if ("export" in d) return exportConfig();
  if ("import" in d) return importConfig();
  if ("resetAll" in d) {
    if (!(await confirmBox(t("Reset every setting to its default? Pinned apps and bars are reset too.")))) return;
    config = defaults();
    return changed({ rerender: true });
  }
  if ("pause" in d) return call("set_taskbar_paused", { paused: true }).catch(() => {});
  if ("quit" in d) return call("quit_app").catch(() => {});
});

app.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.path && el.type === "range") {
    const v = Number(el.value);
    setByPath(el.dataset.path, v);
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = `${fmt(v, Number(el.step))}${out.textContent.replace(/^[\d.,-]+/, "")}`;
    return changed();
  }
  if (el.dataset.path && (el.tagName === "TEXTAREA" || el.type === "text" || el.classList.contains("input"))) {
    setByPath(el.dataset.path, el.value);
    return changed();
  }
  if (el.dataset.path && el.type === "color") {
    setByPath(el.dataset.path, el.value);
    el.parentElement.querySelector("[data-reset]")?.classList.remove("is-hidden");
    return changed();
  }
  if ("barName" in el.dataset) {
    config.bars[openBar].name = el.value;
    document.querySelector(`[data-bar-tab="${openBar}"]`).textContent = el.value;
    return changed();
  }
  if (el.dataset.entryField) {
    const found = findItem(el.closest("[data-uid]").dataset.uid);
    const i = Number(el.closest("[data-entry]").dataset.entry);
    found.item.opts.entries[i][el.dataset.entryField] = el.value;
    return changed();
  }
});

app.addEventListener("change", async (e) => {
  const el = e.target;
  if ("autostart" in el.dataset) {
    try {
      const a = await import("@tauri-apps/plugin-autostart");
      if (el.checked) await a.enable();
      else await a.disable();
      autostart = await a.isEnabled();
    } catch {
      // keep the box as the system says
    }
    return render();
  }
  if (!el.dataset.path) return;
  if (el.type === "checkbox") {
    setByPath(el.dataset.path, el.checked);
    return changed({ rerender: el.dataset.path.startsWith("@") });
  }
  if (el.tagName === "SELECT") {
    setByPath(el.dataset.path, el.value);
    if (el.dataset.path === "lang") setLang(el.value);
    return changed({ rerender: true });
  }
});

/* Hotkey recording. */
app.addEventListener("keydown", (e) => {
  const el = e.target;
  if (!el.dataset?.hotkey) return;
  e.preventDefault();
  if (e.key === "Backspace" || e.key === "Delete") {
    set(el.dataset.hotkey, "");
    el.value = "";
    return changed();
  }
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  if (!mods.length) return; // a hotkey needs a modifier
  const key = e.code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
  const value = [...mods, key].join("+");
  set(el.dataset.hotkey, value);
  el.value = value;
  changed();
});

/* Drag items between zones. */
let dragUid = null;
app.addEventListener("dragstart", (e) => {
  const it = e.target.closest?.("[data-uid]");
  if (!it) return;
  dragUid = it.dataset.uid;
  it.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
});
app.addEventListener("dragend", () => {
  dragUid = null;
  document.querySelectorAll(".is-dragging, .is-drop").forEach((x) => x.classList.remove("is-dragging", "is-drop"));
});
app.addEventListener("dragover", (e) => {
  const col = e.target.closest?.("[data-drop]");
  if (!col || !dragUid) return;
  e.preventDefault();
  document.querySelectorAll(".is-drop").forEach((x) => x !== col && x.classList.remove("is-drop"));
  col.classList.add("is-drop");
});
app.addEventListener("drop", (e) => {
  const col = e.target.closest?.("[data-drop]");
  if (!col || !dragUid) return;
  e.preventDefault();
  const found = findItem(dragUid);
  if (!found) return;
  found.bar.items[found.zone].splice(found.index, 1);
  const target = config.bars[openBar].items[col.dataset.drop];
  // Before the item it was dropped on, or at the end.
  const over = e.target.closest("[data-uid]");
  const at = over ? target.findIndex((x) => x.uid === over.dataset.uid) : -1;
  target.splice(at < 0 ? target.length : at, 0, found.item);
  changed({ rerender: true });
});

/* ---------- small dialogs ---------- */

function alertBox(message) {
  modal(t("Dynamic Dock"), `<p>${escapeHtml(message)}</p><div class="modal-btns"><button class="primary" data-close>${t("OK")}</button></div>`);
}

function confirmBox(message) {
  return new Promise((resolve) => {
    modal(t("Dynamic Dock"), `<p>${escapeHtml(message)}</p><div class="modal-btns"><button class="ghost" data-close>${t("Cancel")}</button><button class="primary is-danger" data-ok>${t("Reset")}</button></div>`, (e, close) => {
      if (e.target.closest("[data-ok]")) {
        close();
        resolve(true);
      }
    });
    // Closing any other way says no.
    const wrap = document.querySelector(".modal-wrap:last-child");
    new MutationObserver((_, obs) => {
      if (!document.body.contains(wrap)) {
        obs.disconnect();
        resolve(false);
      }
    }).observe(document.body, { childList: true });
  });
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "dynamic-dock-settings.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importConfig() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    try {
      const text = await input.files[0].text();
      config = normalise(JSON.parse(text));
      changed({ rerender: true });
    } catch {
      alertBox(t("That file couldn't be read as Dynamic Dock settings."));
    }
  });
  input.click();
}

/* ---------- start ---------- */

async function boot() {
  config = await loadConfig();
  setLang(config.lang);
  try {
    section = location.hash.slice(1) || localStorage.getItem("dd.settings.section") || "general";
    localStorage.removeItem("dd.settings.section");
  } catch {
    // ignore
  }
  if (!SECTIONS.some(([id]) => id === section)) section = "general";
  if (inTauri) {
    try {
      const a = await import("@tauri-apps/plugin-autostart");
      autostart = await a.isEnabled();
    } catch {
      autostart = null;
    }
  }
  render();
  window.addEventListener("hashchange", () => {
    const next = location.hash.slice(1);
    if (SECTIONS.some(([id]) => id === next)) {
      section = next;
      render();
    }
  });
  onUpdate((s) => {
    update = s;
    if (section === "updates") render();
  });
  readVersion().catch(() => {});
  onConfigChange((next) => {
    // Changes made from the dock itself (pinning, a city…).
    if (JSON.stringify(next) === JSON.stringify(config)) return;
    config = next;
    render();
  });
  if (inTauri) call("settings_ready").catch(() => {});
}

boot();
