// Dynamic Launcher: the search box that opens with Alt+Space (or the
// dock's button). Rust does the searching (src-tauri/src/palette); this
// page draws the results, animates them and handles the keyboard.
//
// The window is made once and then shown and hidden, so this page stays
// loaded: every opening resets it instead of reloading it.

import "./launcher.css";
import { call, on, inTauri } from "../lib/tauri.js";
import { loadConfig, saveConfig, onConfigChange, ZONES } from "../lib/config.js";
import { applyLook } from "../lib/themes.js";
import { setLang, getLang, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { escapeHtml } from "../lib/util.js";
import { getIcon } from "../dock/data.js";
import { demoSearch } from "./demo.js";

const root = document.documentElement;
const app = document.getElementById("app");

app.innerHTML = `
  <div class="panel" id="panel">
    <div class="search">
      <span class="search-ic">${icon("search")}</span>
      <input id="q" type="text" autocomplete="off" spellcheck="false" />
      <span class="mode" id="mode" hidden></span>
      <kbd class="esc">Esc</kbd>
    </div>
    <div class="results" id="results"><div class="sel" id="sel"></div><div class="rows" id="rows" role="listbox"></div></div>
    <div class="foot" id="foot"></div>
    <div class="actions" id="actions" hidden></div>
  </div>`;

const panel = document.getElementById("panel");
const input = document.getElementById("q");
const modeEl = document.getElementById("mode");
const results = document.getElementById("results");
const rowsEl = document.getElementById("rows");
const selEl = document.getElementById("sel");
const foot = document.getElementById("foot");
const actionsEl = document.getElementById("actions");

let config = null;
let hits = [];
let sel = 0;
let open = false;
let closing = false;
let token = 0; // the latest search; older answers are dropped
let closedAt = 0;
let armed = null; // { key, at }: a row waiting for its second Enter
let actions = null; // { list, sel } while the actions menu is open
let pointer = { x: -1, y: -1 };
let pinned = new Set();

const MAX_HEIGHT = 432;
const reduced = () => root.dataset.reduce === "true";
const wait = (ms) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms * Number(root.style.getPropertyValue("--speed") || 1)));

if (!inTauri) document.body.classList.add("is-demo");

/* ---------- look ---------- */

async function applyConfig() {
  setLang(config.lang);
  let env = { light: matchMedia("(prefers-color-scheme: light)").matches };
  if (inTauri) env = { ...env, ...((await call("palette_env").catch(() => null)) || {}) };
  applyLook(root, config.look, env);
  root.style.setProperty("--speed", String(1 / Math.max(0.25, config.motion.speed)));
  root.dataset.reduce = String(config.motion.reduce || matchMedia("(prefers-reduced-motion: reduce)").matches);
  document.getElementById("custom-css").textContent = config.look.customCss || "";
  input.placeholder = t("Search apps, windows, settings, or type a sum");
  pinned = new Set(
    config.bars
      .flatMap((b) => ZONES.flatMap((z) => b.items[z]))
      .filter((x) => x.type === "apps")
      .flatMap((x) => x.opts.pinned || [])
      .map((p) => String(p.id || "").toLowerCase())
  );
}

/* ---------- searching ---------- */

const MODES = { "=": "Calculator", ">": "Commands", "w ": "Open windows", "?": "Web" };

function modeOf(text) {
  const t2 = text.trimStart();
  for (const prefix of Object.keys(MODES)) if (t2.startsWith(prefix)) return MODES[prefix];
  return "";
}

async function search(keepSelection = false) {
  const text = input.value;
  const mine = ++token;
  const mode = modeOf(text);
  modeEl.hidden = !mode;
  modeEl.textContent = mode ? t(mode) : "";
  const found = inTauri ? await call("palette_query", { text, lang: getLang() }).catch(() => []) : demoSearch(text);
  if (mine !== token) return;
  const before = hits[sel]?.key;
  hits = found || [];
  sel = keepSelection ? Math.max(0, hits.findIndex((h) => h.key === before)) : 0;
  if (armed && !hits.some((h) => h.key === armed.key)) armed = null;
  render();
}

/* ---------- drawing ---------- */

const KIND = {
  app: "App",
  window: "Window",
  setting: "Settings",
  command: "Command",
  shortcut: "Shortcut",
  calc: "Calculator",
  web: "Web",
};

const ENGINES = { google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", yandex: "Yandex" };

// Same folding as Rust (palette/fuzzy.rs), for highlighting what matched.
const FOLD = { ı: "i", İ: "i", ş: "s", Ş: "s", ğ: "g", Ğ: "g", ü: "u", Ü: "u", ö: "o", Ö: "o", ç: "c", Ç: "c" };
const fold = (s) => [...s].map((c) => FOLD[c] ?? c.toLowerCase().normalize("NFD")[0]).join("");

/** The title with the typed letters marked. */
function highlight(title, query) {
  const q = fold(query.trim().replace(/^(=|>|w |\?)/, "").trim());
  if (!q) return escapeHtml(title);
  const chars = [...title];
  const f = fold(title);
  const marks = new Set();
  const at = f.indexOf(q);
  if (at >= 0) {
    for (let i = at; i < at + q.length; i++) marks.add(i);
  } else {
    // Letters in order, preferring the starts of words.
    let qi = 0;
    const fc = [...f];
    for (let i = 0; i < fc.length && qi < q.length; i++) {
      if (q[qi] === " ") qi++;
      if (fc[i] === q[qi]) {
        marks.add(i);
        qi++;
      }
    }
    if (qi < q.length) marks.clear();
  }
  let out = "";
  let inMark = false;
  chars.forEach((c, i) => {
    const m = marks.has(i);
    if (m !== inMark) out += m ? "<mark>" : "</mark>";
    inMark = m;
    out += escapeHtml(c);
  });
  return inMark ? `${out}</mark>` : out;
}

function title(hit) {
  if (hit.kind === "web") return escapeHtml(t("Search the web for “{q}”", { q: hit.title }));
  if (hit.kind === "calc") return `<span class="calc-eq">=</span> ${escapeHtml(hit.title)}`;
  return highlight(hit.title, input.value);
}

function subtitle(hit) {
  if (armed?.key === hit.key) return `<span class="warn">${escapeHtml(t("Press Enter again to confirm"))}</span>`;
  if (hit.kind === "web") return escapeHtml(ENGINES[hit.subtitle] || hit.subtitle);
  if (hit.kind === "calc") return escapeHtml(hit.subtitle);
  if (hit.kind === "window") return escapeHtml(hit.subtitle);
  if (hit.kind === "shortcut") return escapeHtml(hit.target);
  return "";
}

function tag(hit) {
  if (hit.kind === "app" && hit.running) return `<span class="tag is-running"><i></i>${escapeHtml(t("Running"))}</span>`;
  return `<span class="tag">${escapeHtml(t(KIND[hit.kind] || ""))}</span>`;
}

function iconHtml(hit) {
  if (hit.kind === "calc") return `<span class="glyph is-calc">${icon("sparkle")}</span>`;
  const glyph = `<span class="glyph">${icon(hit.glyph || "apps")}</span>`;
  return hit.icon ? `<img alt="" draggable="false" data-icon="${escapeHtml(hit.icon)}" hidden />${glyph}` : glyph;
}

const GROUPS = { suggested: "Suggestions", windows: "Open windows" };

function render() {
  // Where each row was, to slide the ones that stay (FLIP).
  const before = new Map([...rowsEl.querySelectorAll(".row")].map((r) => [r.dataset.key, r.offsetTop]));
  let html = "";
  let group = null;
  hits.forEach((h, i) => {
    if (h.group && h.group !== group) {
      group = h.group;
      html += `<div class="group">${escapeHtml(t(GROUPS[group] || group))}</div>`;
    }
    html += `<div class="row ${armed?.key === h.key ? "is-armed" : ""}" data-i="${i}" data-key="${escapeHtml(`${h.key}|${h.hwnd || ""}|${h.group || ""}`)}" role="option">
      <span class="row-ic">${iconHtml(h)}</span>
      <span class="row-text"><span class="row-title">${title(h)}</span>${subtitle(h) ? `<span class="row-sub">${subtitle(h)}</span>` : ""}</span>
      ${tag(h)}
    </div>`;
  });
  if (!hits.length) {
    html = input.value.trim()
      ? `<div class="none">${icon("search")}<span>${escapeHtml(t("Nothing found"))}</span></div>`
      : `<div class="none is-hello">${icon("sparkle")}<span>${escapeHtml(t("Type to search. = for sums, > for commands, w for windows, ? for the web."))}</span></div>`;
  }
  rowsEl.innerHTML = html;

  for (const img of rowsEl.querySelectorAll("img[data-icon]")) {
    getIcon(img.dataset.icon).then((src) => {
      if (!src || !img.isConnected) return;
      img.src = src;
      img.hidden = false;
      img.nextElementSibling?.remove();
    });
  }

  let n = 0;
  for (const r of rowsEl.querySelectorAll(".row")) {
    const old = before.get(r.dataset.key);
    if (old != null && !reduced()) {
      const dy = old - r.offsetTop;
      if (dy) {
        r.style.transform = `translateY(${dy}px)`;
        r.style.transition = "none";
        requestAnimationFrame(() => {
          r.style.transition = "";
          r.style.transform = "";
        });
      }
    } else if (old == null) {
      r.classList.add("is-new");
      r.style.animationDelay = `${Math.min(n, 8) * 14}ms`;
    }
    n++;
  }

  // The content's own height (scrollHeight never drops below the box).
  const last = rowsEl.lastElementChild;
  const h = Math.min(last ? last.offsetTop + last.offsetHeight + 6 : 0, MAX_HEIGHT);
  results.style.height = `${h}px`;
  placeSel(false);
  paintFoot();
}

function rowEl(i) {
  return rowsEl.querySelector(`.row[data-i="${i}"]`);
}

/** Moves the highlight to the selected row, sliding. */
function placeSel(scroll = true) {
  rowsEl.querySelectorAll(".row.is-sel").forEach((r) => r.classList.remove("is-sel"));
  const r = rowEl(sel);
  if (!r) {
    selEl.style.opacity = "0";
    return;
  }
  r.classList.add("is-sel");
  selEl.style.opacity = "1";
  selEl.style.height = `${r.offsetHeight}px`;
  selEl.style.transform = `translateY(${r.offsetTop - rowsEl.scrollTop}px)`;
  if (scroll) {
    const top = r.offsetTop;
    const bottom = top + r.offsetHeight;
    if (top < rowsEl.scrollTop) rowsEl.scrollTo({ top: top - 6, behavior: reduced() ? "auto" : "smooth" });
    else if (bottom > rowsEl.scrollTop + results.clientHeight) rowsEl.scrollTo({ top: bottom - results.clientHeight + 6, behavior: reduced() ? "auto" : "smooth" });
  }
  paintFoot();
}

rowsEl.addEventListener("scroll", () => {
  const r = rowEl(sel);
  if (r) {
    selEl.style.transition = "none";
    selEl.style.transform = `translateY(${r.offsetTop - rowsEl.scrollTop}px)`;
    requestAnimationFrame(() => (selEl.style.transition = ""));
  }
});

const kbd = (keys, label) => `<span class="hint">${keys.map((k) => `<kbd>${k}</kbd>`).join("")}${escapeHtml(label)}</span>`;

function paintFoot() {
  const h = hits[sel];
  const parts = [];
  if (h) {
    const main = {
      app: h.running ? "Switch to" : "Open",
      window: "Switch to",
      setting: "Open",
      command: "Run",
      shortcut: "Open",
      calc: "Copy",
      web: "Search",
    }[h.kind];
    parts.push(kbd(["↵"], t(main || "Open")));
    if (h.kind === "app" && h.running) parts.push(kbd(["⇧", "↵"], t("New window")));
    if (h.kind === "app" || h.kind === "shortcut") parts.push(kbd(["Ctrl", "↵"], t("As administrator")));
    parts.push(kbd(["Ctrl", "K"], t("Actions")));
  }
  foot.innerHTML = `<span class="brand">${icon("sparkle")}Dynamic Launcher</span><span class="hints">${parts.join("")}</span>`;
}

/* ---------- running ---------- */

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function toast(text) {
  foot.innerHTML = `<span class="toast">${icon("check")}${escapeHtml(text)}</span>`;
}

async function pulse(i) {
  const r = rowEl(i);
  if (!r || reduced()) return;
  r.classList.add("is-fired");
  await wait(110);
}

async function runHit(i, action = "open") {
  const hit = hits[i];
  if (!hit || closing) return;
  if (hit.kind === "calc" || action === "copy") {
    await copy(action === "copy" ? hit.path || hit.target || hit.title : hit.title);
    toast(t("Copied"));
    await pulse(i);
    await wait(260);
    return close(true);
  }
  if (action === "copyQuery") {
    await copy(hit.title);
    toast(t("Copied"));
    await wait(260);
    return close(true);
  }
  if (action === "pin") return pin(hit);
  if (action === "forget") {
    await call("palette_run", { hit, action: "forget", query: input.value }).catch(() => {});
    toast(t("Removed from suggestions"));
    return search(true);
  }
  if (action === "close") {
    await call("task_action", { hwnd: hit.hwnd, action: "close" }).catch(() => {});
    await wait(150);
    return search(true);
  }
  if (hit.confirm && action === "open" && !(armed?.key === hit.key && Date.now() - armed.at < 4000)) {
    armed = { key: hit.key, at: Date.now() };
    render();
    return;
  }
  armed = null;
  await pulse(i);
  const query = input.value;
  await close(false, async () => {
    // Run first, then hide: hiding may close the window (when it isn't
    // kept ready), and the run must already be on its way.
    if (inTauri) call("palette_run", { hit, action, query }).catch((e) => call("log_message", { message: `launcher: ${e}` }).catch(() => {}));
  });
}

async function pin(hit) {
  const apps = config.bars.flatMap((b) => ZONES.flatMap((z) => b.items[z])).find((x) => x.type === "apps");
  if (!apps) return;
  const id = String(hit.target).toLowerCase();
  if (!(apps.opts.pinned || []).some((p) => String(p.id).toLowerCase() === id)) {
    apps.opts.pinned = [...(apps.opts.pinned || []), { kind: "app", id: hit.target, path: hit.path, name: hit.title }];
    config = await saveConfig(config);
    pinned.add(id);
  }
  toast(t("Pinned to the dock"));
}

/* ---------- the actions menu (Ctrl+K) ---------- */

function actionList(hit) {
  const list = [];
  const add = (id, label, ic) => list.push({ id, label: t(label), icon: ic });
  const hasFile = hit.path && !hit.path.includes("://") && !hit.path.startsWith("shell:");
  switch (hit.kind) {
    case "app":
      add("open", hit.running ? "Switch to" : "Open", hit.running ? "window" : "rocket");
      if (hit.running) add("new", "New window", "plus");
      add("admin", "Run as administrator", "shield");
      if (hasFile) add("reveal", "Open file location", "folder");
      if (hasFile) add("copy", "Copy path", "clipboard");
      if (!pinned.has(String(hit.target).toLowerCase())) add("pin", "Pin to the dock", "pin");
      break;
    case "window":
      add("open", "Switch to", "window");
      add("close", "Close window", "close");
      if (hasFile) add("reveal", "Open file location", "folder");
      break;
    case "shortcut":
      add("open", "Open", "rocket");
      add("admin", "Run as administrator", "shield");
      if (hasFile) add("reveal", "Open file location", "folder");
      add("copy", "Copy path", "clipboard");
      break;
    case "setting":
      add("open", "Open", "gear");
      break;
    case "command":
      add("open", "Run", "play");
      break;
    case "calc":
      add("open", "Copy", "clipboard");
      break;
    case "web":
      add("open", "Search", "globe");
      add("copyQuery", "Copy", "clipboard");
      break;
  }
  if (["app", "setting", "command", "shortcut", "window"].includes(hit.kind) && hit.group === "suggested") add("forget", "Remove from suggestions", "trash");
  return list;
}

function openActions() {
  const hit = hits[sel];
  if (!hit) return;
  actions = { list: actionList(hit), sel: 0 };
  paintActions();
  actionsEl.hidden = false;
  requestAnimationFrame(() => actionsEl.classList.add("is-open"));
}

function closeActions() {
  actions = null;
  actionsEl.classList.remove("is-open");
  setTimeout(() => {
    if (!actions) actionsEl.hidden = true;
  }, 160);
}

function paintActions() {
  const hit = hits[sel];
  actionsEl.innerHTML = `<div class="actions-head">${escapeHtml(hit.title)}</div>${actions.list
    .map((a, i) => `<button class="act ${i === actions.sel ? "is-sel" : ""}" data-a="${i}">${icon(a.icon)}<span>${escapeHtml(a.label)}</span></button>`)
    .join("")}`;
}

actionsEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (!b || !actions) return;
  const a = actions.list[Number(b.dataset.a)];
  closeActions();
  runHit(sel, a.id);
});

/* ---------- opening and closing ---------- */

/** `from`: a point in this window to grow out of (the dock's button). */
async function show(from) {
  open = true;
  closing = false;
  closeActions();
  armed = null;
  // A recent search comes back selected, an old one is cleared.
  if (Date.now() - closedAt > 60_000) input.value = "";
  panel.classList.remove("is-open", "is-closing", "from-dock");
  if (from && !reduced()) {
    const r = panel.getBoundingClientRect();
    panel.style.transformOrigin = `${from.x - r.left}px ${from.y - r.top}px`;
    panel.classList.add("from-dock");
  } else {
    panel.style.transformOrigin = "";
  }
  void panel.offsetWidth;
  requestAnimationFrame(() => panel.classList.add("is-open"));
  input.focus();
  input.select();
  await search();
}

/** Plays the closing animation, then hides the window. `restore`: give
 * the focus back to the window that had it. */
async function close(restore = true, before) {
  if (closing) return;
  closing = true;
  open = false;
  closeActions();
  panel.classList.remove("is-open");
  panel.classList.add("is-closing");
  closedAt = Date.now();
  await wait(110);
  await before?.();
  if (inTauri) await call("palette_hide", { restore }).catch(() => {});
  else setTimeout(() => show(), 700); // the demo opens again by itself
  closing = false;
}

/* ---------- keyboard and pointer ---------- */

function move(step) {
  if (!hits.length) return;
  sel = (sel + step + hits.length) % hits.length;
  if (armed && hits[sel]?.key !== armed.key) {
    armed = null;
    render();
  }
  placeSel();
}

input.addEventListener("input", () => {
  armed = null;
  search();
});

window.addEventListener("keydown", (e) => {
  if (actions) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      actions.sel = (actions.sel + (e.key === "ArrowDown" ? 1 : -1) + actions.list.length) % actions.list.length;
      return paintActions();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = actions.list[actions.sel];
      closeActions();
      return runHit(sel, a.id);
    }
    if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      return closeActions();
    }
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      return move(1);
    case "ArrowUp":
      e.preventDefault();
      return move(-1);
    case "Tab":
      e.preventDefault();
      return move(e.shiftKey ? -1 : 1);
    case "PageDown":
      e.preventDefault();
      return move(Math.min(5, hits.length - 1 - sel) || 0);
    case "PageUp":
      e.preventDefault();
      return move(-Math.min(5, sel) || 0);
    case "Enter":
      e.preventDefault();
      return runHit(sel, e.ctrlKey ? "admin" : e.shiftKey ? "new" : "open");
    case "Escape":
      e.preventDefault();
      if (input.value) {
        input.value = "";
        return search();
      }
      return close(true);
  }
  if (e.ctrlKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openActions();
  }
});

rowsEl.addEventListener("pointermove", (e) => {
  // Only a real move picks a row, not the list sliding under a still pointer.
  if (e.clientX === pointer.x && e.clientY === pointer.y) return;
  pointer = { x: e.clientX, y: e.clientY };
  const r = e.target.closest(".row");
  if (r && Number(r.dataset.i) !== sel) {
    sel = Number(r.dataset.i);
    placeSel(false);
  }
});

rowsEl.addEventListener("click", (e) => {
  const r = e.target.closest(".row");
  if (r) runHit(Number(r.dataset.i), e.ctrlKey ? "admin" : e.shiftKey ? "new" : "open");
});

rowsEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  if (!r) return;
  sel = Number(r.dataset.i);
  placeSel(false);
  openActions();
});

// A click on the see-through part of the window closes the box.
document.addEventListener("pointerdown", (e) => {
  if (!panel.contains(e.target)) close(true);
});

/* ---------- start ---------- */

function report(what) {
  call("log_message", { message: `launcher: ${what}` }).catch(() => {});
}
window.addEventListener("error", (e) => report(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => report(e.reason?.stack || e.reason));

async function boot() {
  config = await loadConfig();
  await applyConfig();
  onConfigChange(async (next) => {
    config = next;
    await applyConfig();
    if (open) search(true);
  });
  if (inTauri) {
    on("palette://show", (from) => show(from));
    on("palette://close", (restore) => close(restore !== false));
    on("palette://index", () => open && search(true));
    await call("palette_ready");
  } else {
    show();
  }
}

boot().catch((e) => report(`boot failed: ${e?.stack || e}`));
