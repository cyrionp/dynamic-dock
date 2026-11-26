// Single buttons that open a part of Windows (Start, search, Task View…),
// plus the dock's own small pieces: show desktop, settings, separator,
// space and the bar switcher.

import { call, inTauri } from "../../lib/tauri.js";
import { icon } from "../../lib/icons.js";
import { t } from "../../lib/i18n.js";
import { CATALOG } from "../../lib/config.js";

/** The Windows logo, drawn as four tiles. */
const START_ICON = `<svg class="ic ic-start" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8.4" height="8.4" rx="1.4"/><rect x="12.6" y="3" width="8.4" height="8.4" rx="1.4"/><rect x="3" y="12.6" width="8.4" height="8.4" rx="1.4"/><rect x="12.6" y="12.6" width="8.4" height="8.4" rx="1.4"/></svg>`;

function shortcutButton(name, iconName, custom) {
  return {
    render(el, item, ctx) {
      el.innerHTML = `<button class="btn" data-mag>${custom ?? icon(iconName)}</button>`;
      const b = el.firstChild;
      const label = t(CATALOG[item.type].label);
      b.setAttribute("aria-label", label);
      b.addEventListener("click", () => {
        ctx.hideTip();
        call("shortcut", { name }).catch(() => {});
      });
      b.addEventListener("pointerenter", () => ctx.showTip(b, label));
      b.addEventListener("pointerleave", () => ctx.hideTip());
      return {};
    },
  };
}

export const start = shortcutButton("start", "start", START_ICON);
export const search = shortcutButton("search", "search");
export const taskview = shortcutButton("taskview", "taskview");
export const widgetsWin = shortcutButton("widgets", "widgets");
export const notifications = shortcutButton("notifications", "bell");
export const quicksettings = shortcutButton("quicksettings", "toggles");
export const clipboard = shortcutButton("clipboard", "clipboard");
export const snip = shortcutButton("snip", "scissors");
export const explorer = shortcutButton("explorer", "folder");
export const settingsWin = shortcutButton("settings", "gear");
export const run = shortcutButton("run", "terminal");

export const desktop = {
  render(el, item, ctx) {
    el.innerHTML = item.opts.thin ? `<button class="desk-strip" aria-label="${t("Show desktop")}"></button>` : `<button class="btn" data-mag>${icon("desktop")}</button>`;
    const b = el.firstChild;
    b.addEventListener("click", () => call("shortcut", { name: "desktop" }).catch(() => {}));
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Show desktop")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    return {};
  },
};

export const dockSettings = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn" data-mag>${icon("sliders")}</button>`;
    const b = el.firstChild;
    b.addEventListener("click", () => ctx.openSettings());
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Dock settings")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    return {};
  },
};

export const separator = {
  render(el) {
    el.innerHTML = `<span class="sep"></span>`;
    return {};
  },
};

export const spacer = {
  render(el, item) {
    el.style.width = `${item.opts.width}px`;
    el.classList.add("spacer");
    return {};
  },
};

export const barSwitcher = {
  render(el, item, ctx) {
    const paint = () => {
      el.innerHTML = `<span class="switcher">${ctx.bars
        .map((b, i) => `<button class="sw-dot ${i === ctx.barIndex ? "is-on" : ""}" data-i="${i}" aria-label="${b.name}"></button>`)
        .join("")}</span>`;
    };
    paint();
    el.addEventListener("click", (e) => {
      const d = e.target.closest("[data-i]");
      if (d) ctx.switchTo(Number(d.dataset.i));
    });
    el.addEventListener("pointerover", (e) => {
      const d = e.target.closest("[data-i]");
      if (d) ctx.showTip(d, ctx.bars[Number(d.dataset.i)].name);
    });
    el.addEventListener("pointerout", () => ctx.hideTip());
    return {};
  },
};

/** Opens Dynamic Launcher, which grows out of this button. */
export const palette = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn btn-palette" data-mag>${icon("sparkle")}</button>`;
    const b = el.firstChild;
    const tip = () => {
      const key = ctx.hotkeys.openLauncher;
      return key ? `${t("Dynamic Launcher")} (${key})` : t("Dynamic Launcher");
    };
    b.setAttribute("aria-label", t("Dynamic Launcher"));
    b.addEventListener("click", () => {
      ctx.hideTip();
      const r = b.getBoundingClientRect();
      if (!inTauri) return window.open("launcher.html", "dd-launcher", "width=760,height=580");
      call("palette_toggle", { x: r.left + r.width / 2, y: r.top + r.height / 2 }).catch(() => {});
    });
    b.addEventListener("pointerenter", () => ctx.showTip(b, tip()));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    return {};
  },
};
