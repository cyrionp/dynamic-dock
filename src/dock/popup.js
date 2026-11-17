// Pop-ups (a widget's panel), context menus and tooltips. All live inside
// the dock window, in the transparent room above (or below) the bar; the
// hit-test areas are reported so only they take clicks.

import { call } from "../lib/tauri.js";
import { icon } from "../lib/icons.js";
import { escapeHtml } from "../lib/util.js";

const layer = document.getElementById("layer");
let current = null; // { el, cleanup, anchor, focus, kind }
let onChange = () => {};
let placement = { top: false };

/** `fn()` runs whenever a pop-up or menu opens or closes (hit areas). */
export function onLayerChange(fn) {
  onChange = fn;
}

export function setPlacement(p) {
  placement = p;
}

export const isOpen = () => Boolean(current);
export const openAnchor = () => current?.anchor ?? null;

/** Rectangles of whatever is open, for the hit test. */
export function layerRects() {
  if (!current) return [];
  const r = current.el.getBoundingClientRect();
  return [{ x: r.left, y: r.top, width: r.width, height: r.height }];
}

function position(el, anchor, width) {
  const vw = window.innerWidth;
  const bar = document.querySelector(".bar.is-current")?.getBoundingClientRect();
  const a = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const w = Math.min(width, vw - 16);
  let x = a.left + a.width / 2 - w / 2;
  x = Math.max(8, Math.min(vw - w - 8, x));
  el.style.width = `${w}px`;
  el.style.left = `${x}px`;
  const origin = Math.max(12, Math.min(w - 12, a.left + a.width / 2 - x));
  el.style.setProperty("--origin-x", `${origin}px`);
  if (placement.top) {
    const top = (bar ? bar.bottom : a.bottom) + 10;
    el.style.top = `${top}px`;
    el.style.maxHeight = `${window.innerHeight - top - 12}px`;
  } else {
    const bottom = window.innerHeight - (bar ? bar.top : a.top) + 10;
    el.style.bottom = `${bottom}px`;
    el.style.maxHeight = `${window.innerHeight - bottom - 12}px`;
  }
}

/**
 * Opens a panel over `anchor`. `build(body, close)` fills it and may return
 * a clean-up function. `focus: true` lets the panel take the keyboard
 * (typing notes or timer lengths).
 */
export function openPopup(anchor, { build, width = 320, className = "", focus = false, kind = "popup" }) {
  const same = current && current.anchor === anchor && current.kind === kind;
  closePopup();
  if (same) return null; // a second click on the same item closes it
  const el = document.createElement("div");
  el.className = `popup ${className} ${placement.top ? "from-top" : ""}`;
  layer.append(el);
  position(el, anchor, width);
  const entry = { el, anchor, focus, kind, cleanup: null };
  current = entry;
  entry.cleanup = build(el, closePopup) || null;
  // Content may have changed the height; keep it on screen.
  position(el, anchor, width);
  requestAnimationFrame(() => el.classList.add("is-open"));
  call("set_watch_outside", { on: true }).catch(() => {});
  if (focus) call("dock_focus", { focus: true }).catch(() => {});
  anchor.classList?.add?.("is-open");
  onChange();
  return el;
}

export function closePopup() {
  if (!current) return;
  const { el, cleanup, focus, anchor } = current;
  current = null;
  try {
    cleanup?.();
  } catch {
    // a widget's clean-up must not keep the pop-up open
  }
  anchor.classList?.remove?.("is-open");
  el.classList.remove("is-open");
  el.classList.add("is-closing");
  el.style.pointerEvents = "none";
  setTimeout(() => el.remove(), 180);
  call("set_watch_outside", { on: false }).catch(() => {});
  if (focus) call("dock_focus", { focus: false }).catch(() => {});
  onChange();
}

/** Re-places the open pop-up (its content grew or shrank). */
export function repositionPopup() {
  if (!current) return;
  position(current.el, current.anchor, parseFloat(current.el.style.width));
  onChange();
}

/**
 * A context menu. `items`: { label, icon, action, danger, disabled, checked }
 * or "-" for a separator.
 */
export function openMenu(anchor, items, width = 240) {
  return openPopup(anchor, {
    width,
    kind: "menu",
    className: "menu",
    build(el, close) {
      el.innerHTML = items
        .map((it, i) =>
          it === "-"
            ? `<div class="menu-sep"></div>`
            : it.header
              ? `<div class="menu-head">${escapeHtml(it.header)}</div>`
              : `<button class="menu-item ${it.danger ? "is-danger" : ""}" data-i="${i}" ${it.disabled ? "disabled" : ""}>
                  <span class="menu-ic">${it.checked ? icon("check") : it.icon ? icon(it.icon) : ""}</span>
                  <span class="menu-label">${escapeHtml(it.label)}</span>
                  ${it.hint ? `<span class="menu-hint">${escapeHtml(it.hint)}</span>` : ""}
                </button>`
        )
        .join("");
      el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        close();
        items[Number(b.dataset.i)].action?.();
      });
    },
  });
}

/* ---------- tooltips ---------- */

const tip = document.createElement("div");
tip.className = "tip";
layer.append(tip);
let tipTimer = 0;
let tipsOn = true;

export function setTooltips(on) {
  tipsOn = on;
  if (!on) hideTip();
}

export function showTip(el, text) {
  if (!tipsOn || !text || current) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tip.textContent = text;
    const r = el.getBoundingClientRect();
    tip.classList.add("is-on");
    const w = tip.offsetWidth;
    const x = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    tip.style.left = `${x}px`;
    if (placement.top) {
      tip.style.top = `${r.bottom + 12}px`;
      tip.style.bottom = "";
    } else {
      tip.style.bottom = `${window.innerHeight - r.top + 12}px`;
      tip.style.top = "";
    }
  }, 420);
}

export function hideTip() {
  clearTimeout(tipTimer);
  tip.classList.remove("is-on");
}
