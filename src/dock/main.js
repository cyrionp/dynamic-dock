// The dock page. It draws the current bar (one of up to three), switches
// between them with an animation, magnifies icons under the pointer,
// hides itself when asked to, and keeps Rust told which parts of the
// window are painted, so clicks anywhere else go to the apps underneath.

import "./dock.css";
import { call, on, inTauri, isPrimaryDock } from "../lib/tauri.js";
import { loadConfig, saveConfig, onConfigChange, ZONES } from "../lib/config.js";
import { applyLook } from "../lib/themes.js";
import { setLang, t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { WIDGETS } from "./widgets/index.js";
import { pinFromTaskbar } from "./widgets/apps.js";
import { env as envSource } from "./data.js";
import { checkOnLaunch, onUpdate, installUpdate, readVersion } from "../lib/updates.js";
import {
  openPopup,
  openMenu,
  closePopup,
  repositionPopup,
  isOpen,
  layerRects,
  onLayerChange,
  setPlacement,
  showTip,
  hideTip,
  setTooltips,
} from "./popup.js";

const root = document.documentElement;
const dock = document.getElementById("dock");
const barsEl = document.getElementById("bars");
const customCss = document.getElementById("custom-css");

let config = null;
let env = envSource.value;
let barIndex = 0;
let mounted = []; // { destroy } of the current bar's items
let hovering = false;
let hidden = false;
let forcedHidden = false; // the "toggle dock" hotkey
let magnifyPaused = false;

if (!inTauri) document.body.classList.add("is-demo");

/* ---------- look ---------- */

function applyConfig() {
  const { look, motion, shell, behavior } = config;
  setLang(config.lang);
  applyLook(root, look, env);
  root.style.setProperty("--bar-h", `${shell.barHeight}px`);
  // Same as Rust: the full width bar sits on the edge, with no margin.
  root.style.setProperty("--margin", `${look.style === "full" ? 0 : shell.margin}px`);
  root.style.setProperty("--speed", String(1 / Math.max(0.25, motion.speed)));
  root.dataset.position = shell.position;
  root.dataset.reduce = String(motion.reduce || matchMedia("(prefers-reduced-motion: reduce)").matches);
  root.dataset.hover = motion.hover;
  root.dataset.switch = motion.switchStyle;
  customCss.textContent = look.customCss || "";
  setPlacement({ top: shell.position === "top" });
  setTooltips(behavior.tooltips);
  call("set_tray_labels", {
    labels: {
      settings: t("Settings"),
      pause: t("Show the Windows taskbar for now"),
      restart: t("Restart Dynamic Dock"),
      exit: t("Exit"),
    },
  }).catch(() => {});
}

/* ---------- building a bar ---------- */

function itemContext(item) {
  return {
    motion: config.motion,
    bars: config.bars,
    barIndex,
    openPopup,
    openMenu,
    repositionPopup,
    showTip,
    hideTip,
    layoutChanged: scheduleHits,
    setMagnifyPaused: (p) => {
      magnifyPaused = p;
      if (p) resetMagnify();
    },
    switchTo: (i) => switchTo(i),
    openSettings,
    async saveItemOpts(patch) {
      for (const bar of config.bars) {
        for (const z of ZONES) {
          const found = bar.items[z].find((x) => x.uid === item.uid);
          if (found) found.opts = { ...found.opts, ...patch };
        }
      }
      config = await saveConfig(config);
      if (!inTauri) rebuild();
    },
  };
}

function mountItems(container, items, out) {
  for (const item of items) {
    const widget = WIDGETS[item.type];
    if (!widget) continue;
    const el = document.createElement("div");
    el.className = `it it-${item.type}`;
    el.dataset.uid = item.uid;
    container.append(el);
    try {
      out.push(widget.render(el, item, itemContext(item)) || {});
    } catch (err) {
      console.error(item.type, err);
      el.remove();
    }
  }
}

function dotsHtml() {
  if (!config.behavior.showBarDots || config.bars.length < 2) return "";
  return `<span class="bar-dots">${config.bars
    .map((b, i) => `<button class="bar-dot ${i === barIndex ? "is-on" : ""}" data-bar="${i}" aria-label="${b.name}"></button>`)
    .join("")}</span>`;
}

/** Creates the DOM for bar `i` and mounts its widgets into `out`. */
function buildBar(i, out) {
  const bar = config.bars[i];
  const el = document.createElement("div");
  el.className = "bar";
  el.dataset.index = String(i);
  const style = config.look.style;
  const zones = ZONES.filter((z) => bar.items[z].length);
  // The zone with the open programs is the one that gives way when the bar
  // runs out of room, so it never slides under the clock or the others.
  const flex = ZONES.find((z) => bar.items[z].some((it) => it.type === "apps"));
  if (flex) el.dataset.flex = flex;

  if (style === "split") {
    for (const z of ZONES) {
      const slot = document.createElement("div");
      slot.className = `slot slot-${z}`;
      el.append(slot);
      if (!bar.items[z].length) continue;
      const pill = document.createElement("div");
      pill.className = `pill zone-${z}${z === flex ? " has-apps" : ""}`;
      slot.append(pill);
      mountItems(pill, bar.items[z], out);
    }
  } else {
    const pill = document.createElement("div");
    pill.className = `pill ${style === "full" ? "is-full" : ""}`;
    el.append(pill);
    for (const z of style === "full" ? ZONES : zones) {
      const group = document.createElement("div");
      group.className = `zone zone-${z}${z === flex ? " has-apps" : ""}`;
      pill.append(group);
      mountItems(group, bar.items[z], out);
    }
  }
  // Bar dots go at the end of the last pill.
  const pills = el.querySelectorAll(".pill");
  const last = pills[pills.length - 1];
  if (last) last.insertAdjacentHTML("beforeend", dotsHtml());
  else el.innerHTML = `<div class="slot slot-center"><div class="pill">${dotsHtml() || `<span class="empty-bar">${t("This bar is empty")}</span>`}</div></div>`;
  return el;
}

function destroyMounted(list) {
  for (const m of list) {
    try {
      m.destroy?.();
    } catch {
      // keep going
    }
  }
}

function rebuild() {
  closePopup();
  destroyMounted(mounted);
  mounted = [];
  barIndex = Math.min(barIndex, config.bars.length - 1);
  barsEl.replaceChildren();
  const el = buildBar(barIndex, mounted);
  el.classList.add("is-current");
  barsEl.append(el);
  resetMagnify();
  scheduleHits();
}

/* ---------- switching ---------- */

let switching = false;
let returnTimer = 0;

function switchTo(i, dir) {
  const n = config.bars.length;
  if (n < 2) return;
  const next = ((i % n) + n) % n;
  if (next === barIndex || switching) return;
  dir ??= next > barIndex ? 1 : -1;
  closePopup();
  hideTip();
  resetMagnify();
  const old = barsEl.querySelector(".bar.is-current");
  const oldMounted = mounted;
  mounted = [];
  barIndex = next;
  const el = buildBar(next, mounted);
  barsEl.append(el);
  const style = config.motion.switchStyle;
  if (style === "none" || root.dataset.reduce === "true") {
    old?.remove();
    destroyMounted(oldMounted);
    el.classList.add("is-current");
    scheduleHits();
    return;
  }
  switching = true;
  const way = dir > 0 ? "next" : "prev";
  el.classList.add("is-current", "is-entering", `go-${way}`);
  old?.classList.remove("is-current");
  old?.classList.add("is-leaving", `go-${way}`);
  const done = () => {
    old?.remove();
    destroyMounted(oldMounted);
    el.classList.remove("is-entering", "go-next", "go-prev");
    switching = false;
    scheduleHits();
  };
  // The animation's own length, scaled by the motion speed.
  setTimeout(done, 420 * Number(root.style.getPropertyValue("--speed") || 1));
  scheduleHits();
  armReturn();
}

/** Goes back to the first bar after a while away from the dock. */
function armReturn() {
  clearTimeout(returnTimer);
  const secs = config.behavior.returnToMain;
  if (!secs || barIndex === 0) return;
  returnTimer = setTimeout(() => {
    if (hovering || isOpen()) return armReturn();
    switchTo(0, -1);
  }, secs * 1000);
}

// The wheel over an empty part of a bar flips through the bars.
let wheelSum = 0;
let wheelAt = 0;
dock.addEventListener(
  "wheel",
  (e) => {
    if (!config?.behavior.wheelSwitch || config.bars.length < 2 || e.defaultPrevented) return;
    const now = Date.now();
    if (now - wheelAt > 400) wheelSum = 0;
    wheelAt = now;
    wheelSum += e.deltaY || e.deltaX;
    if (Math.abs(wheelSum) >= 60) {
      switchTo(barIndex + Math.sign(wheelSum), Math.sign(wheelSum));
      wheelSum = 0;
    }
  },
  { passive: true }
);

dock.addEventListener("click", (e) => {
  const d = e.target.closest("[data-bar]");
  if (d) switchTo(Number(d.dataset.bar));
});

dock.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (e.target.closest(".it")) return; // items have their own menus
  const pill = e.target.closest(".pill");
  if (!pill) return;
  openMenu({ x: e.clientX, y: e.clientY, getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: pill.getBoundingClientRect().top, bottom: pill.getBoundingClientRect().bottom, width: 0 }) }, [
    { header: config.bars[barIndex].name },
    ...config.bars.map((b, i) => ({ label: b.name, checked: i === barIndex, action: () => switchTo(i) })),
    "-",
    { label: t("Edit this bar…"), icon: "edit", action: () => openSettings("bars") },
    { label: t("Dock settings"), icon: "sliders", action: () => openSettings() },
    { label: t("Task Manager"), icon: "cpu", action: () => call("launch", { target: "taskmgr.exe" }).catch(() => {}) },
  ]);
});

/* ---------- magnification ---------- */

let magFrame = 0;
let magX = 0;
let magPill = null;

function resetMagnify() {
  cancelAnimationFrame(magFrame);
  magPill = null;
  for (const c of dock.querySelectorAll("[data-mag].is-mag")) {
    c.classList.remove("is-mag");
    c.style.removeProperty("--s");
  }
  dock.classList.remove("is-magnifying");
}

function magnify() {
  const { magnify: on, magnifyScale, magnifyRange } = config.motion;
  if (!on || magnifyPaused || !magPill || root.dataset.reduce === "true") return;
  const cells = magPill.querySelectorAll("[data-mag]");
  if (!cells.length) return;
  const base = cells[0].offsetWidth || 40;
  const reach = Math.max(1, magnifyRange) * base;
  dock.classList.add("is-magnifying");
  for (const c of cells) {
    const r = c.getBoundingClientRect();
    const d = Math.abs(magX - (r.left + r.width / 2));
    // A smooth bump: 1 under the pointer, fading to 0 at `reach`.
    const f = d >= reach ? 0 : (Math.cos((d / reach) * Math.PI) + 1) / 2;
    const s = 1 + (magnifyScale - 1) * f;
    if (s > 1.001) {
      c.classList.add("is-mag");
      c.style.setProperty("--s", s.toFixed(3));
    } else if (c.classList.contains("is-mag")) {
      c.classList.remove("is-mag");
      c.style.removeProperty("--s");
    }
  }
}

dock.addEventListener("pointermove", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  if (pill !== magPill) resetMagnify();
  magPill = pill;
  magX = e.clientX;
  cancelAnimationFrame(magFrame);
  magFrame = requestAnimationFrame(magnify);
});

/* ---------- hover and auto-hide ---------- */

function setHovering(on) {
  if (hovering === on) return;
  hovering = on;
  dock.classList.toggle("is-hover", on);
  if (!on) {
    resetMagnify();
    hideTip();
    armReturn();
  }
  updateHidden();
  scheduleHits();
}

dock.addEventListener("pointerenter", () => setHovering(true));
document.getElementById("edge").addEventListener("pointerenter", () => setHovering(true));
dock.addEventListener("pointerleave", () => setHovering(false));

let hideTimer = 0;
function updateHidden() {
  if (!config) return;
  const mode = config.shell.autoHide;
  let want = forcedHidden;
  if (!want && mode === "always") want = !hovering && !isOpen();
  if (!want && mode === "smart") want = env.overlapped && !hovering && !isOpen();
  clearTimeout(hideTimer);
  if (want === hidden) return;
  // Showing is instant; hiding waits a little, so passing by doesn't flicker.
  const delay = want && !forcedHidden ? config.behavior.autoHideDelay : 0;
  hideTimer = setTimeout(() => {
    hidden = want;
    dock.classList.toggle("is-hidden", hidden);
    if (hidden) closePopup();
    scheduleHits();
  }, delay);
}

/* ---------- hit areas ---------- */

let hitFrame = 0;
let lastHits = "";

function scheduleHits() {
  cancelAnimationFrame(hitFrame);
  hitFrame = requestAnimationFrame(reportHits);
}

function reportHits() {
  if (!config) return;
  const rects = [];
  const top = config.shell.position === "top";
  if (hidden) {
    // A thin strip along the edge brings it back.
    rects.push({ x: 0, y: top ? 0 : window.innerHeight - 3, width: window.innerWidth, height: 3 });
  } else {
    const iconSize = Math.min(config.look.iconSize, config.shell.barHeight - 16);
    const headroom = config.motion.magnify ? iconSize * (config.motion.magnifyScale - 1) + 10 : 0;
    for (const pill of barsEl.querySelectorAll(".bar.is-current .pill")) {
      const r = pill.getBoundingClientRect();
      if (!r.width) continue;
      const extra = hovering ? headroom : 0;
      rects.push({ x: r.left - 2, y: (top ? r.top : r.top - extra) - 2, width: r.width + 4, height: r.height + extra + 4 });
    }
    rects.push(...layerRects());
  }
  const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round)));
  if (key === lastHits) return;
  lastHits = key;
  call("set_hit_rects", { rects }).catch(() => {});
}

new ResizeObserver(scheduleHits).observe(barsEl);
window.addEventListener("resize", scheduleHits);
dock.addEventListener("transitionend", scheduleHits);
onLayerChange(() => {
  updateHidden();
  scheduleHits();
});

/* ---------- settings ---------- */

function openSettings(section) {
  if (section) {
    try {
      localStorage.setItem("dd.settings.section", section);
    } catch {
      // ignore
    }
  }
  if (inTauri) call("open_settings").catch(() => {});
  else window.open(`settings.html${section ? `#${section}` : ""}`, "dd-settings", "width=1060,height=740");
}

/* ---------- boot ---------- */

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopup();
});

/* ---------- updates ---------- */

let offeredUpdate = "";
function offerUpdate(s) {
  if (s.status !== "available" || offeredUpdate === s.next) return;
  offeredUpdate = s.next;
  const anchor = barsEl.querySelector(".bar.is-current .slot-center .pill, .bar.is-current .pill");
  if (!anchor) return;
  openPopup(anchor, {
    width: 320,
    className: "update-pop",
    build(body, close) {
      const paint = (st) => {
        body.innerHTML = `<div class="update-row">${icon("download")}<div><div class="pop-title">${t("Update available")}</div>
          <p class="hint">${t("Dynamic Dock {version} is ready to install.", { version: st.next })}${st.error ? `<br>${st.error}` : ""}</p></div></div>
          <div class="update-btns">${
            st.status === "installing"
              ? `<span class="hint">${t("Installing… {percent}%", { percent: st.progress })}</span>`
              : `<button class="chip-btn" data-later>${t("Later")}</button><button class="btn-primary" data-install>${t("Install and restart")}</button>`
          }</div>`;
      };
      const off = onUpdate(paint);
      body.addEventListener("click", (e) => {
        if (e.target.closest("[data-later]")) close();
        if (e.target.closest("[data-install]")) installUpdate();
      });
      return off;
    },
  });
}

// Errors go to the log file (%LOCALAPPDATA%\DynamicDock\dock.log).
function report(what) {
  call("log_message", { message: String(what) }).catch(() => {});
}
window.addEventListener("error", (e) => report(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => report(e.reason?.stack || e.reason));

// Tells Rust the page is drawn and running. Rust only hides the Windows
// taskbar while these keep coming, so a broken page never leaves the user
// with no taskbar at all.
function startHeartbeat() {
  const beat = () => call("dock_alive").catch(() => {});
  beat();
  setInterval(beat, 1000);
}

/** First start: the apps the Windows taskbar had pinned become the dock's. */
async function importTaskbarPins() {
  const found = await call("taskbar_pins").catch(() => null);
  if (!found) return;
  const apps = config.bars.flatMap((b) => ZONES.flatMap((z) => b.items[z])).find((x) => x.type === "apps");
  if (apps && !apps.opts.pinned?.length) {
    const seen = new Set();
    apps.opts = {
      ...apps.opts,
      pinned: found.map(pinFromTaskbar).filter((p) => !seen.has(p.id.toLowerCase()) && seen.add(p.id.toLowerCase())),
    };
  }
  config.pinsImported = true;
  config = await saveConfig(config);
}

async function boot() {
  config = await loadConfig();
  if (inTauri && isPrimaryDock && !config.pinsImported) await importTaskbarPins();
  applyConfig();
  rebuild();
  armReturn();
  readVersion().catch(() => {});
  // One update check and offer, on the main screen's dock.
  if (config.updates.auto && isPrimaryDock) checkOnLaunch();
  onUpdate(offerUpdate);

  onConfigChange((next) => {
    config = next;
    applyConfig();
    rebuild();
    updateHidden();
  });

  envSource.subscribe((next) => {
    const lookChanged = next.light !== env.light || next.accent !== env.accent;
    env = next;
    if (lookChanged) applyLook(root, config.look, env);
    updateHidden();
  });

  if (inTauri) {
    on("pointer://leave", () => setHovering(false));
    on("pointer://outside", () => closePopup());
    on("hotkey://action", (action) => {
      if (action === "nextBar") switchTo(barIndex + 1, 1);
      else if (action === "previousBar") switchTo(barIndex - 1, -1);
      else if (/^bar\d$/.test(action)) switchTo(Number(action.slice(3)) - 1);
      else if (action === "toggleDock") {
        forcedHidden = !forcedHidden;
        updateHidden();
      }
    });
  } else {
    // In a browser the arrow keys stand in for the hotkeys.
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.altKey && e.key === "ArrowRight") switchTo(barIndex + 1, 1);
      if (e.ctrlKey && e.altKey && e.key === "ArrowLeft") switchTo(barIndex - 1, -1);
    });
    document.body.insertAdjacentHTML("afterbegin", `<div class="demo-note">${icon("info")} ${t("Preview in a browser: sample data, no Windows.")}</div>`);
  }
}

boot()
  .then(() => requestAnimationFrame(startHeartbeat))
  .catch((e) => report(`boot failed: ${e?.stack || e}`));
