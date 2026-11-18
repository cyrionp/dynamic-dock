// The taskbar part of the dock: pinned apps and open windows, grouped by
// app, with magnification, launch bounce, drag to reorder, window lists
// and context menus. Also the "Shortcuts" launcher.

import { call, inTauri } from "../../lib/tauri.js";
import { icon } from "../../lib/icons.js";
import { escapeHtml, baseName, prettyName } from "../../lib/util.js";
import { t } from "../../lib/i18n.js";
import { tasks, badges, paintIcon } from "../data.js";
import { demo } from "../demo.js";
import { load, save } from "../../lib/store.js";

const lower = (s) => String(s || "").toLowerCase();

/** A pinned app matches a window by its app id or its program. */
const matches = (pin, w) => (pin.id && lower(pin.id) === lower(w.appId)) || (pin.path && lower(pin.path) === lower(w.exe));

const iconKeyOf = (pin) => (pin.kind === "app" ? `shell:AppsFolder\\${pin.id}` : pin.path || pin.link || pin.id);

function launchPin(pin, admin = false) {
  if (pin.kind === "app" && !admin) return call("launch_app", { id: pin.id });
  // A pin taken from the Windows taskbar starts through its shortcut, which
  // keeps its arguments (a browser profile, say).
  if (pin.link && !admin) return call("launch", { target: pin.link, args: "", admin });
  return call("launch", { target: pin.path || pin.link || pin.id, args: pin.args || "", admin });
}

/** A pin made from one of the Windows taskbar's own pins. */
export function pinFromTaskbar(p) {
  const exe = /\.exe$/i.test(p.target) ? p.target : "";
  return { kind: "file", id: p.appId || exe || p.link, path: exe, link: p.link, name: p.name };
}

/** A pin made from an app in Start's list. */
const pinFromInstalled = (a) => ({ kind: "app", id: a.id, path: a.path || "", name: a.name });

const samePin = (a, b) => lower(a.id) === lower(b.id) || (a.path && lower(a.path) === lower(b.path));

let installedCache = null;
async function installedApps() {
  if (!installedCache) {
    installedCache = inTauri ? call("installed_apps") : Promise.resolve(demo.apps);
    installedCache.catch(() => (installedCache = null));
  }
  return installedCache;
}

/** Puts the entries in the order the user left them (`order`, a list of
 * keys). An entry not in it yet goes after the pinned entry before it, or at
 * the end when it is only running, so pins and open apps can be mixed. */
export function arrange(natural, order) {
  const byKey = new Map();
  for (const e of natural) if (!byKey.has(e.key)) byKey.set(e.key, e);
  const out = [];
  for (const k of order) {
    const e = byKey.get(k);
    if (e && !out.includes(e)) out.push(e);
  }
  const pinned = [...byKey.values()].filter((e) => e.pin);
  pinned.forEach((e, i) => {
    if (out.includes(e)) return;
    const before = pinned.slice(0, i).reverse().find((p) => out.includes(p));
    const after = pinned.slice(i + 1).find((p) => out.includes(p));
    const at = before ? out.indexOf(before) + 1 : after ? out.indexOf(after) : 0;
    out.splice(at, 0, e);
  });
  for (const e of byKey.values()) if (!out.includes(e)) out.push(e);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What pinning a running window stores. */
function pinFromWindow(w) {
  const aumid = w.appId && !w.appId.includes("\\") ? w.appId : null;
  const packaged = w.icon.startsWith("shell:AppsFolder\\");
  return packaged && aumid
    ? { kind: "app", id: aumid, path: w.exe, name: nameOf(w) }
    : { kind: "file", id: w.exe, path: w.exe, name: nameOf(w) };
}

function nameOf(w) {
  const base = prettyName(baseName(w.exe));
  if (!base || /^applicationframehost$/i.test(base)) return w.title;
  return base;
}

export const apps = {
  render(el, item, ctx) {
    el.classList.add("apps");
    const cells = new Map(); // key → element
    let windows = [];
    let entries = [];
    const launching = new Map(); // key → timer
    let lastFocus = new Map(); // key → index for "cycle"
    // The order of the icons, shared by the dock on every screen and kept
    // across restarts, so a pinned or dragged app stays where it was put.
    const orderKey = `apps.order.${item.uid}`;
    let order = load(orderKey, []);
    if (!Array.isArray(order)) order = [];
    const setOrder = (keys) => {
      if (sameList(keys, order)) return;
      order = keys;
      save(orderKey, keys);
    };

    function build() {
      const o = item.opts;
      const used = new Set();
      const out = [];
      if (o.showPinned) {
        for (const pin of o.pinned) {
          const wins = windows.filter((w) => !used.has(w.hwnd) && matches(pin, w));
          wins.forEach((w) => used.add(w.hwnd));
          out.push({ key: `p:${lower(pin.id)}`, pin, wins });
        }
      }
      if (o.showRunning) {
        const groups = new Map();
        for (const w of windows) {
          if (used.has(w.hwnd)) continue;
          const key = runningKey(w);
          if (!groups.has(key)) groups.set(key, { key, pin: null, wins: [] });
          groups.get(key).wins.push(w);
        }
        out.push(...groups.values());
      }
      const arranged = arrange(out, order);
      setOrder(arranged.map((e) => e.key));
      return arranged;
    }

    /** The key a running window gets when it is not pinned. */
    const runningKey = (w) => (item.opts.group ? `g:${lower(w.appId)}` : `w:${w.hwnd}`);

    /** Pins a running app right where its icon is. */
    function pinInPlace(e) {
      const pin = pinFromWindow(e.wins[0]);
      const key = `p:${lower(pin.id)}`;
      const at = entries.indexOf(e);
      const pinnedBefore = entries.slice(0, at).filter((x) => x.pin).length;
      const pins = item.opts.pinned.slice();
      pins.splice(pinnedBefore, 0, pin);
      setOrder(entries.map((x) => (x === e ? key : x.key)).filter((k, i, all) => all.indexOf(k) === i));
      setPinned(pins);
    }

    /** Unpins; an app that is still open keeps its place. */
    function unpin(e) {
      const keys = entries.map((x) => x.key);
      if (e.wins.length) keys[entries.indexOf(e)] = runningKey(e.wins[0]);
      else keys.splice(entries.indexOf(e), 1);
      setOrder(keys);
      setPinned(item.opts.pinned.filter((p) => p !== e.pin));
    }

    function cellHtml(e) {
      return `<span class="cell-icon"><img alt="" hidden draggable="false" /><b class="cell-badge" hidden></b></span><span class="cell-label"></span><span class="cell-ind"></span>`;
    }

    function paint() {
      entries = build();
      const seen = new Set();
      let prev = null;
      for (const e of entries) {
        seen.add(e.key);
        let c = cells.get(e.key);
        if (!c) {
          c = document.createElement("button");
          c.className = "cell is-new";
          c.dataset.mag = "";
          c.dataset.key = e.key;
          c.innerHTML = cellHtml(e);
          const iconKey = e.pin ? iconKeyOf(e.pin) : e.wins[0]?.icon;
          paintIcon(c.querySelector("img"), iconKey, icon("window", "cell-fallback"));
          cells.set(e.key, c);
          requestAnimationFrame(() => requestAnimationFrame(() => c.classList.remove("is-new")));
        }
        const running = e.wins.length > 0;
        const active = e.wins.some((w) => w.active);
        c.classList.toggle("is-running", running);
        c.classList.toggle("is-active", active);
        c.classList.toggle("is-pinned", Boolean(e.pin));
        c.classList.toggle("is-hidden-all", running && e.wins.every((w) => w.minimized));
        c.dataset.count = String(Math.min(3, e.wins.length));
        c.querySelector(".cell-ind").innerHTML = running ? "<i></i>".repeat(Math.min(3, e.wins.length)) : "";
        // The app's notification count, as on the taskbar.
        const badge = item.opts.badges ? badgeOf(e) : "";
        const b = c.querySelector(".cell-badge");
        if (b.textContent !== badge) b.textContent = badge;
        b.hidden = !badge;
        b.classList.toggle("is-dot", badge === "•");
        const label = e.wins.length === 1 ? e.wins[0].title : e.pin?.name || (e.wins[0] ? nameOf(e.wins[0]) : "");
        c._tip = e.wins.length > 1 ? `${e.pin?.name || nameOf(e.wins[0])} · ${t("{n} windows", { n: e.wins.length })}` : label || e.pin?.name;
        const lab = c.querySelector(".cell-label");
        lab.textContent = item.opts.labels ? label : "";
        c.classList.toggle("has-label", Boolean(item.opts.labels && label));
        if (running && launching.has(e.key)) {
          clearTimeout(launching.get(e.key));
          launching.delete(e.key);
          c.classList.remove("is-launching");
        }
        // Keep DOM order equal to the entry order, moving only what moved.
        const want = prev ? prev.nextSibling : el.firstChild;
        if (want !== c) el.insertBefore(c, want);
        prev = c;
      }
      for (const [key, c] of cells) {
        if (seen.has(key)) continue;
        cells.delete(key);
        c.classList.add("is-leaving");
        setTimeout(() => c.remove(), 220);
      }
      el.style.setProperty("--label-w", `${item.opts.labelWidth}px`);
      scrollBy(0);
      ctx.layoutChanged();
    }

    /* ---------- too many to fit: scroll ---------- */

    el.insertAdjacentHTML(
      "beforeend",
      `<button class="apps-more apps-more-l" tabindex="-1">${icon("left")}</button><button class="apps-more apps-more-r" tabindex="-1">${icon("right")}</button>`
    );
    let shift = 0;
    /** How far the icons reach past the visible part, in pixels. */
    function overflow() {
      const cs = [...el.querySelectorAll(".cell:not(.is-leaving)")];
      if (!cs.length) return 0;
      const last = cs[cs.length - 1];
      const width = last.offsetLeft + last.offsetWidth - cs[0].offsetLeft;
      return Math.max(0, Math.ceil(width - el.clientWidth));
    }
    function scrollBy(dx) {
      const max = overflow();
      const next = Math.max(0, Math.min(max, shift + dx));
      if (next !== shift) {
        shift = next;
        el.style.setProperty("--apps-x", `${-shift}px`);
      }
      el.classList.toggle("can-left", shift > 0);
      el.classList.toggle("can-right", shift < max);
    }
    el.addEventListener(
      "wheel",
      (ev) => {
        if (!overflow()) return;
        // Marked as used, so the dock doesn't switch bars too.
        ev.preventDefault();
        scrollBy(ev.deltaY || ev.deltaX);
      },
      { passive: false }
    );
    for (const [cls, dir] of [
      [".apps-more-l", -1],
      [".apps-more-r", 1],
    ]) {
      const b = el.querySelector(cls);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        scrollBy(dir * Math.max(60, el.clientWidth * 0.75));
      });
      b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    }
    const resized = new ResizeObserver(() => scrollBy(0));
    resized.observe(el);

    const entryOf = (c) => entries.find((e) => e.key === c.dataset.key);

    let badgeMap = {};
    function badgeOf(e) {
      const ids = [e.pin?.id, ...e.wins.map((w) => w.appId)];
      for (const id of ids) {
        const v = id && badgeMap[lower(id)];
        if (v) return v;
      }
      return "";
    }

    function bounce(c, key) {
      if (!ctx.motion.bounce) return;
      c.classList.remove("is-launching");
      void c.offsetWidth;
      c.classList.add("is-launching");
      clearTimeout(launching.get(key));
      launching.set(
        key,
        setTimeout(() => {
          c.classList.remove("is-launching");
          launching.delete(key);
        }, 2600)
      );
    }

    function launch(e, c, admin = false) {
      bounce(c, e.key);
      if (e.pin) return launchPin(e.pin, admin).catch(() => {});
      const exe = e.wins[0]?.exe;
      if (exe) call("launch", { target: exe, admin }).catch(() => {});
    }

    const act = (w, action = "activate") => call("task_action", { hwnd: w.hwnd, action }).catch(() => {});

    function windowList(c, e) {
      ctx.openPopup(c, {
        width: 320,
        className: "winlist",
        build(body, close) {
          const paintList = () => {
            body.innerHTML = `<div class="pop-title">${escapeHtml(e.pin?.name || nameOf(e.wins[0]))}</div>
              <div class="winlist-rows">${e.wins
                .map(
                  (w) => `<div class="winrow ${w.active ? "is-active" : ""} ${w.minimized ? "is-min" : ""}" data-h="${w.hwnd}">
                    <span class="winrow-title">${escapeHtml(w.title)}</span>
                    <button class="icon-btn" data-close="${w.hwnd}" title="${t("Close")}">${icon("close")}</button>
                  </div>`
                )
                .join("")}</div>`;
          };
          paintList();
          body.addEventListener("click", (ev) => {
            const x = ev.target.closest("[data-close]");
            if (x) {
              const w = e.wins.find((w) => String(w.hwnd) === x.dataset.close);
              if (w) act(w, "close");
              x.closest(".winrow")?.classList.add("is-closing");
              return;
            }
            const row = ev.target.closest("[data-h]");
            if (row) {
              const w = e.wins.find((w) => String(w.hwnd) === row.dataset.h);
              close();
              if (w) act(w, "focus");
            }
          });
        },
      });
    }

    function onClick(c, ev) {
      const e = entryOf(c);
      if (!e) return;
      ctx.hideTip();
      if (!e.wins.length) return launch(e, c);
      if (ev.shiftKey) return launch(e, c);
      if (e.wins.length === 1) return act(e.wins[0]);
      switch (item.opts.multiClick) {
        case "cycle": {
          const active = e.wins.findIndex((w) => w.active);
          const next = e.wins[(active + 1) % e.wins.length];
          return act(next, "focus");
        }
        case "last": {
          const w = e.wins.find((w) => w.active) ?? e.wins[e.wins.length - 1];
          return act(w);
        }
        default:
          return windowList(c, e);
      }
    }

    function menu(c) {
      const e = entryOf(c);
      if (!e) return;
      const name = e.pin?.name || nameOf(e.wins[0]);
      const items = [{ header: name }];
      for (const w of e.wins.slice(0, 8)) {
        items.push({ label: w.title, icon: w.active ? "check" : "window", action: () => act(w, "focus") });
      }
      if (e.wins.length) items.push("-");
      items.push({ label: t("New window"), icon: "plus", action: () => launch(e, c) });
      items.push({ label: t("Run as administrator"), icon: "shield", action: () => launch(e, c, true) });
      if (e.pin) {
        items.push({ label: t("Unpin from the dock"), icon: "unpin", action: () => unpin(e) });
      } else if (e.wins[0]) {
        items.push({ label: t("Pin to the dock"), icon: "pin", action: () => pinInPlace(e) });
      }
      items.push({ label: t("Pin an app…"), icon: "plus", action: () => pickApp(c) });
      if (e.wins.length === 1) {
        const w = e.wins[0];
        items.push("-");
        items.push({ label: w.minimized ? t("Restore") : t("Minimise"), icon: "minimize", action: () => act(w, w.minimized ? "restore" : "minimize") });
        items.push({ label: t("Maximise"), icon: "maximize", action: () => act(w, "maximize") });
      }
      if (e.wins.length) {
        items.push("-");
        items.push({
          label: e.wins.length > 1 ? t("Close all windows") : t("Close window"),
          icon: "close",
          danger: true,
          action: () => e.wins.forEach((w) => act(w, "close")),
        });
      }
      ctx.openMenu(c, items);
    }

    function setPinned(pinned) {
      ctx.saveItemOpts({ pinned });
    }

    /** Right-click on the apps area itself, not on an icon. */
    function areaMenu(ev) {
      const anchor = {
        getBoundingClientRect: () => {
          const r = el.getBoundingClientRect();
          return { left: ev.clientX, right: ev.clientX, top: r.top, bottom: r.bottom, width: 0, height: r.height };
        },
      };
      ctx.openMenu(anchor, [
        { header: t("Pinned apps") },
        { label: t("Pin an app…"), icon: "plus", action: () => pickApp(el) },
        { label: t("Add the Windows taskbar's pins"), icon: "pin", action: importTaskbar },
        { label: t("Edit this bar…"), icon: "edit", action: () => ctx.openSettings("bars") },
      ]);
    }

    async function importTaskbar() {
      const found = inTauri ? await call("taskbar_pins").catch(() => []) : [];
      const pins = item.opts.pinned.slice();
      for (const p of found.map(pinFromTaskbar)) if (!pins.some((x) => samePin(x, p))) pins.push(p);
      setPinned(pins);
    }

    /** A searchable list of everything in Start; a click pins (or unpins). */
    function pickApp(anchor) {
      ctx.openPopup(anchor, {
        width: 340,
        className: "pinpick",
        focus: true,
        kind: "pinpick",
        build(body) {
          body.innerHTML = `<div class="pop-title">${t("Pin an app")}</div>
            <input class="input pinpick-search" placeholder="${escapeHtml(t("Search apps"))}" />
            <div class="pinpick-list"><div class="pinpick-empty">${t("Loading…")}</div></div>`;
          const input = body.querySelector("input");
          const list = body.querySelector(".pinpick-list");
          let all = [];
          // Saving rebuilds the bar (and closes pop-ups), so the choices are
          // kept here and saved once, when the list closes.
          const before = item.opts.pinned;
          let pinned = before.slice();
          const paintList = () => {
            const q = lower(input.value.trim());
            const shown = all.filter((a) => !q || lower(a.name).includes(q)).slice(0, 80);
            list.innerHTML = shown.length
              ? shown
                  .map((a) => {
                    const on = pinned.some((p) => samePin(p, pinFromInstalled(a)));
                    return `<button class="pinpick-row ${on ? "is-on" : ""}" data-id="${escapeHtml(a.id)}">
                      <span class="pinpick-ic"><img alt="" hidden draggable="false" /></span>
                      <span class="pinpick-name">${escapeHtml(a.name)}</span>
                      <span class="pinpick-state">${on ? icon("check") : icon("pin")}</span>
                    </button>`;
                  })
                  .join("")
              : `<div class="pinpick-empty">${t("Nothing found")}</div>`;
            for (const row of list.querySelectorAll("[data-id]")) {
              paintIcon(row.querySelector("img"), `shell:AppsFolder\\${row.dataset.id}`, icon("window"));
            }
          };
          installedApps()
            .then((apps) => {
              all = apps || [];
              paintList();
            })
            .catch(() => (list.innerHTML = `<div class="pinpick-empty">${t("Nothing found")}</div>`));
          input.addEventListener("input", paintList);
          list.addEventListener("click", (ev) => {
            const row = ev.target.closest("[data-id]");
            const app = row && all.find((a) => a.id === row.dataset.id);
            if (!app) return;
            const pin = pinFromInstalled(app);
            const has = pinned.some((p) => samePin(p, pin));
            pinned = has ? pinned.filter((p) => !samePin(p, pin)) : [...pinned, pin];
            row.classList.toggle("is-on", !has);
            row.querySelector(".pinpick-state").innerHTML = has ? icon("pin") : icon("check");
          });
          setTimeout(() => input.focus(), 60);
          return () => {
            const changed = pinned.length !== before.length || pinned.some((p, i) => p !== before[i]);
            if (changed) setTimeout(() => setPinned(pinned), 0);
          };
        },
      });
    }

    /* ---------- dragging apps to reorder ---------- */

    let drag = null;
    el.addEventListener("pointerdown", (ev) => {
      const c = ev.target.closest(".cell");
      if (!c || ev.button !== 0) return;
      drag = { c, x: ev.clientX, moved: false, id: ev.pointerId };
    });
    el.addEventListener("pointermove", (ev) => {
      if (!drag || drag.id !== ev.pointerId) return;
      const dx = ev.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) {
        const e = entryOf(drag.c);
        if (!e?.pin && !e?.wins.length) return (drag = null);
        drag.moved = true;
        drag.c.setPointerCapture(ev.pointerId);
        drag.c.classList.add("is-dragging");
        ctx.setMagnifyPaused(true);
        ctx.hideTip();
      }
      drag.c.style.transform = `translateX(${dx}px)`;
    });
    const endDrag = (ev) => {
      if (!drag) return;
      const { c, moved } = drag;
      drag = null;
      if (!moved) return;
      c.classList.remove("is-dragging");
      c.style.transform = "";
      ctx.setMagnifyPaused(false);
      // Where it was dropped, among all cells.
      const others = [...el.querySelectorAll(".cell:not(.is-leaving)")].filter((x) => x !== c);
      let index = others.findIndex((x) => {
        const r = x.getBoundingClientRect();
        return ev.clientX < r.left + r.width / 2;
      });
      if (index < 0) index = others.length;
      // Any icon can go anywhere; the pins keep the same order as on screen.
      const keys = others.map((x) => x.dataset.key);
      keys.splice(index, 0, c.dataset.key);
      setOrder(keys);
      const byKey = new Map(entries.map((x) => [x.key, x]));
      const shownPins = keys.map((k) => byKey.get(k)?.pin).filter(Boolean);
      const rest = item.opts.pinned.filter((p) => !shownPins.includes(p));
      const pins = [...shownPins, ...rest];
      if (sameList(pins, item.opts.pinned)) paint();
      else setPinned(pins);
      c._dragged = true;
      setTimeout(() => (c._dragged = false), 50);
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);

    el.addEventListener("click", (ev) => {
      const c = ev.target.closest(".cell");
      if (c && !c._dragged) onClick(c, ev);
    });
    el.addEventListener("auxclick", (ev) => {
      const c = ev.target.closest(".cell");
      if (!c || ev.button !== 1) return;
      const e = entryOf(c);
      if (e) launch(e, c);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const c = ev.target.closest(".cell");
      if (c) menu(c);
      else areaMenu(ev);
    });
    el.addEventListener("pointerover", (ev) => {
      const c = ev.target.closest(".cell");
      if (c && !drag?.moved) ctx.showTip(c, c._tip);
    });
    el.addEventListener("pointerout", (ev) => {
      if (ev.target.closest(".cell")) ctx.hideTip();
    });

    const off = tasks.subscribe((list) => {
      windows = list;
      paint();
    });
    const offBadges = badges.subscribe((map) => {
      badgeMap = map || {};
      paint();
    });
    paint();
    return {
      destroy() {
        off();
        offBadges();
        resized.disconnect();
        for (const timer of launching.values()) clearTimeout(timer);
      },
    };
  },
};

/* ---------- Shortcuts: the user's own files, folders, links ---------- */

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(mailto|ms-settings):/i.test(s);

export const launcher = {
  render(el, item, ctx) {
    el.classList.add("apps", "launcher");
    const entries = item.opts.entries;
    if (!entries.length) {
      el.innerHTML = `<button class="cell is-empty" data-mag>${icon("plus")}</button>`;
      el.firstChild.addEventListener("click", () => ctx.openSettings("bars"));
      el.firstChild._tip = t("Add shortcuts in Settings");
      el.addEventListener("pointerover", () => ctx.showTip(el.firstChild, el.firstChild._tip));
      el.addEventListener("pointerout", () => ctx.hideTip());
      return {};
    }
    el.innerHTML = entries
      .map(
        (e, i) => `<button class="cell" data-mag data-i="${i}"><span class="cell-icon">${
          isUrl(e.target) ? icon("globe", "cell-fallback") : `<img alt="" hidden draggable="false" />`
        }</span><span class="cell-ind"></span></button>`
      )
      .join("");
    el.querySelectorAll(".cell").forEach((c) => {
      const e = entries[Number(c.dataset.i)];
      const img = c.querySelector("img");
      if (img) paintIcon(img, e.target, icon(/\.\w{1,5}$/.test(e.target) ? "file" : "folder", "cell-fallback"));
      c._tip = e.name || baseName(e.target);
    });
    const open = (c, admin = false) => {
      const e = entries[Number(c.dataset.i)];
      if (ctx.motion.bounce) {
        c.classList.remove("is-launching");
        void c.offsetWidth;
        c.classList.add("is-launching");
        setTimeout(() => c.classList.remove("is-launching"), 1400);
      }
      call("launch", { target: e.target, args: e.args || "", admin }).catch(() => {});
    };
    el.addEventListener("click", (ev) => {
      const c = ev.target.closest(".cell");
      if (c) open(c);
    });
    el.addEventListener("contextmenu", (ev) => {
      const c = ev.target.closest(".cell");
      if (!c) return;
      ev.preventDefault();
      const e = entries[Number(c.dataset.i)];
      ctx.openMenu(c, [
        { header: e.name || baseName(e.target) },
        { label: t("Open"), icon: "rocket", action: () => open(c) },
        { label: t("Run as administrator"), icon: "shield", action: () => open(c, true) },
        "-",
        { label: t("Remove"), icon: "close", danger: true, action: () => ctx.saveItemOpts({ entries: entries.filter((x) => x !== e) }) },
        { label: t("Edit shortcuts…"), icon: "edit", action: () => ctx.openSettings("bars") },
      ]);
    });
    el.addEventListener("pointerover", (ev) => {
      const c = ev.target.closest(".cell");
      if (c) ctx.showTip(c, c._tip);
    });
    el.addEventListener("pointerout", () => ctx.hideTip());
    return {};
  },
};
