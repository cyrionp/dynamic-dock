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

/** A folder of pinned apps, like on a phone's home screen. */
const isFolder = (pin) => pin?.kind === "folder";
const newFolder = (apps, name) => ({ kind: "folder", id: `folder-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, apps });

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

/* Window previews: a fixed height, the width follows the window's shape. */
const PREVIEW_H = 128;
const PREVIEW_MIN_W = 110;
const PREVIEW_MAX_W = 260;
const PREVIEW_DEFAULT_W = 200;

function windowPreviews(wins, width, height) {
  if (!inTauri) return Promise.resolve(wins.map((w) => (w.minimized ? null : demo.preview(w))));
  return call("window_previews", { hwnds: wins.map((w) => w.hwnd), width, height });
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
          if (isFolder(pin)) {
            // The windows of every app inside count for the folder.
            const wins = windows.filter((w) => !used.has(w.hwnd) && pin.apps.some((a) => matches(a, w)));
            wins.forEach((w) => used.add(w.hwnd));
            out.push({ key: `f:${pin.id}`, pin, folder: true, wins });
            continue;
          }
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
          if (!e.folder) {
            const iconKey = e.pin ? iconKeyOf(e.pin) : e.wins[0]?.icon;
            paintIcon(c.querySelector("img"), iconKey, icon("window", "cell-fallback"));
          }
          cells.set(e.key, c);
          requestAnimationFrame(() => requestAnimationFrame(() => c.classList.remove("is-new")));
        }
        if (e.folder) paintFolderIcon(c, e.pin);
        c.classList.toggle("is-folder", Boolean(e.folder));
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
        const label = e.folder ? e.pin.name : e.wins.length === 1 ? e.wins[0].title : e.pin?.name || (e.wins[0] ? nameOf(e.wins[0]) : "");
        c._tip = e.folder
          ? `${e.pin.name} · ${t("{n} apps", { n: e.pin.apps.length })}`
          : e.wins.length > 1
            ? `${e.pin?.name || nameOf(e.wins[0])} · ${t("{n} windows", { n: e.wins.length })}`
            : label || e.pin?.name;
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
      // A few pixels are rounding or a magnified icon mid-animation.
      const extra = Math.ceil(width - el.clientWidth);
      return extra > 4 ? extra : 0;
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
      if (e.folder) {
        // A folder adds up its apps' counts (or shows a dot).
        let sum = 0;
        let dot = false;
        for (const a of e.pin.apps) {
          const v = badgeOf({ pin: a, wins: windows.filter((w) => matches(a, w)) });
          if (/^\d+$/.test(v)) sum += Number(v);
          else if (v) dot = v === "•" ? true : (sum += 100);
        }
        return sum > 99 ? "99+" : sum ? String(sum) : dot ? "•" : "";
      }
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
      if (item.opts.previews) return previewList(c, e);
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

    /** The app's windows as live pictures, each shaped like its window, as
     * the taskbar shows them. */
    function previewList(c, e) {
      const H = PREVIEW_H;
      const gap = 8;
      const pad = 12; // the pop-up's padding and border, with a pixel to spare
      const wins = e.wins.slice(0, 12);
      const widthFor = (n, cards) => Math.min(window.innerWidth - 16, cards.reduce((a, w) => a + w, 0) + gap * (n - 1) + pad * 2);
      const sizes = new Map(wins.map((w) => [w.hwnd, PREVIEW_DEFAULT_W]));
      ctx.openPopup(c, {
        width: widthFor(wins.length, [...sizes.values()]),
        className: "winlist is-previews",
        build(body, close) {
          body.innerHTML = `<div class="wcards">${wins
            .map(
              (w) => `<div class="wcard ${w.active ? "is-active" : ""} ${w.minimized ? "is-min" : ""}" data-h="${w.hwnd}" style="--w:${PREVIEW_DEFAULT_W}px">
                <div class="wcard-head"><img class="wcard-ic" alt="" hidden draggable="false" /><span class="wcard-title">${escapeHtml(w.title)}</span>
                  <button class="icon-btn wcard-x" data-close="${w.hwnd}" title="${t("Close")}">${icon("close")}</button></div>
                <div class="wcard-shot" style="height:${H}px"><img alt="" hidden draggable="false" /><span class="wcard-empty">${w.minimized ? t("Minimised") : ""}</span></div>
              </div>`
            )
            .join("")}</div>`;
          for (const card of body.querySelectorAll(".wcard")) {
            const w = wins.find((x) => String(x.hwnd) === card.dataset.h);
            paintIcon(card.querySelector(".wcard-ic"), e.pin ? iconKeyOf(e.pin) : w?.icon, "");
          }
          body.addEventListener("click", (ev) => {
            const x = ev.target.closest("[data-close]");
            if (x) {
              const w = wins.find((w) => String(w.hwnd) === x.dataset.close);
              if (w) act(w, "close");
              x.closest(".wcard")?.classList.add("is-closing");
              return;
            }
            const card = ev.target.closest("[data-h]");
            if (card) {
              const w = wins.find((w) => String(w.hwnd) === card.dataset.h);
              close();
              if (w) act(w, "focus");
            }
          });

          let alive = true;
          const dpr = window.devicePixelRatio || 1;
          const load = async () => {
            const shots = await windowPreviews(
              wins,
              Math.ceil(PREVIEW_MAX_W * dpr),
              Math.ceil(H * dpr)
            ).catch(() => []);
            if (!alive) return;
            wins.forEach((w, i) => {
              const card = body.querySelector(`.wcard[data-h="${w.hwnd}"]`);
              const shot = shots[i];
              if (!card || !shot) return;
              const img = card.querySelector(".wcard-shot img");
              img.onload = () => {
                if (!alive || !img.naturalHeight) return;
                // The card takes the window's shape.
                const cw = Math.round(Math.max(PREVIEW_MIN_W, Math.min(PREVIEW_MAX_W, (H * img.naturalWidth) / img.naturalHeight)));
                if (sizes.get(w.hwnd) !== cw) {
                  sizes.set(w.hwnd, cw);
                  card.style.setProperty("--w", `${cw}px`);
                  queueResize();
                }
              };
              img.src = shot;
              img.hidden = false;
              card.classList.add("has-shot");
            });
          };
          let resizeFrame = 0;
          const queueResize = () => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
              if (!alive) return;
              body.style.width = `${widthFor(wins.length, [...sizes.values()])}px`;
              ctx.repositionPopup();
            });
          };
          load();
          // Keep them fresh while the list is open.
          const timer = setInterval(load, 2000);
          return () => {
            alive = false;
            clearInterval(timer);
            cancelAnimationFrame(resizeFrame);
          };
        },
      });
    }

    function onClick(c, ev) {
      const e = entryOf(c);
      if (!e) return;
      ctx.hideTip();
      if (e.folder) return openFolder(c, e);
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
      if (e.folder) return folderMenu(c, e);
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
      for (const f of item.opts.pinned.filter(isFolder)) {
        items.push({ label: t("Move to “{name}”", { name: f.name }), icon: "layers", action: () => mergeInto(e, entryByKey(`f:${f.id}`)) });
      }
      items.push({ label: t("New folder"), icon: "layers", action: () => folderFrom(e) });
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

    /* ---------- folders ---------- */

    const entryByKey = (key) => entries.find((x) => x.key === key);
    const pinOf = (e) => e.pin ?? pinFromWindow(e.wins[0]);

    /** The folder's icon: its first four apps, small, on a tile. */
    function paintFolderIcon(c, folder) {
      const sig = folder.apps.slice(0, 4).map(iconKeyOf).join("|");
      if (c._sig === sig) return;
      c._sig = sig;
      const box = c.querySelector(".cell-icon");
      box.classList.add("is-folder");
      box.querySelector("img")?.remove();
      box.querySelector(".fold")?.remove();
      const grid = document.createElement("span");
      grid.className = "fold";
      for (const a of folder.apps.slice(0, 4)) {
        const img = document.createElement("img");
        img.alt = "";
        img.hidden = true;
        img.draggable = false;
        grid.append(img);
        paintIcon(img, iconKeyOf(a), "");
      }
      box.prepend(grid);
    }

    /** Puts the app of entry `e` into the folder entry `f` (or, when `f` is an
     * app, makes a folder of the two where `f` was). */
    function mergeInto(e, f) {
      if (!e || !f || e === f || e.folder) return;
      const app = pinOf(e);
      const pins = item.opts.pinned.filter((p) => p !== e.pin);
      const keys = entries.map((x) => x.key).filter((k) => k !== e.key);
      if (f.folder) {
        const folder = { ...f.pin, apps: f.pin.apps.some((a) => samePin(a, app)) ? f.pin.apps : [...f.pin.apps, app] };
        setOrder(keys);
        return setPinned(pins.map((p) => (p === f.pin ? folder : p)));
      }
      const folder = newFolder([pinOf(f), app], t("Folder"));
      const at = pins.indexOf(f.pin);
      if (at >= 0) pins[at] = folder;
      else pins.splice(entries.slice(0, entries.indexOf(f)).filter((x) => x.pin && x !== e).length, 0, folder);
      setOrder(keys.map((k) => (k === f.key ? `f:${folder.id}` : k)));
      setPinned(pins);
    }

    /** A new folder holding just this app, where the app was. */
    function folderFrom(e) {
      const folder = newFolder([pinOf(e)], t("Folder"));
      const pins = item.opts.pinned.slice();
      const at = pins.indexOf(e.pin);
      if (at >= 0) pins[at] = folder;
      else pins.splice(entries.slice(0, entries.indexOf(e)).filter((x) => x.pin).length, 0, folder);
      setOrder(entries.map((x) => (x === e ? `f:${folder.id}` : x.key)));
      setPinned(pins);
    }

    /** Saves a changed folder; an empty one goes away. */
    function saveFolder(folder, changed) {
      const pins = item.opts.pinned.flatMap((p) => (p !== folder ? [p] : changed.apps.length ? [changed] : []));
      setPinned(pins);
    }

    /** Takes the folder apart: its apps go back on the dock, in its place. */
    function ungroup(e) {
      const pins = item.opts.pinned.flatMap((p) => (p === e.pin ? e.pin.apps : [p]));
      const keys = entries.flatMap((x) => (x.key === e.key ? e.pin.apps.map((a) => `p:${lower(a.id)}`) : [x.key]));
      setOrder(keys);
      setPinned(pins);
    }

    /** Takes one app out of the folder (renamed to `name`) and pins it right
     * after the folder. */
    function takeOut(e, app, name) {
      const rest = e.pin.apps.filter((a) => a !== app);
      const pins = item.opts.pinned.flatMap((p) => (p === e.pin ? (rest.length ? [{ ...p, name, apps: rest }, app] : [app]) : [p]));
      const keys = entries.flatMap((x) => (x.key === e.key ? (rest.length ? [x.key, `p:${lower(app.id)}`] : [`p:${lower(app.id)}`]) : [x.key]));
      setOrder(keys);
      setPinned(pins);
    }

    function folderMenu(c, e) {
      ctx.openMenu(c, [
        { header: e.pin.name },
        { label: t("Open"), icon: "layers", action: () => openFolder(c, e) },
        { label: t("Rename…"), icon: "edit", action: () => openFolder(c, e, true) },
        "-",
        { label: t("Ungroup"), icon: "apps", action: () => ungroup(e) },
        { label: t("Remove from the dock"), icon: "unpin", danger: true, action: () => saveFolder(e.pin, { ...e.pin, apps: [] }) },
      ]);
    }

    /** The folder opened: a grid of its apps, and its name to edit. */
    function openFolder(c, e, rename = false) {
      const folder = e.pin;
      ctx.openPopup(c, {
        width: Math.min(4, Math.max(3, folder.apps.length)) * 84 + 34,
        className: "folder-pop",
        focus: true,
        kind: "folder",
        build(body, close) {
          body.innerHTML = `<input class="folder-name" value="${escapeHtml(folder.name)}" spellcheck="false" />
            <div class="folder-grid">${folder.apps
              .map((a, i) => {
                const wins = windows.filter((w) => matches(a, w));
                const badge = item.opts.badges ? badgeOf({ pin: a, wins }) : "";
                return `<button class="folder-app ${wins.length ? "is-running" : ""}" data-i="${i}">
                  <span class="folder-ic"><img alt="" hidden draggable="false" />${badge ? `<b class="cell-badge ${badge === "•" ? "is-dot" : ""}">${escapeHtml(badge === "•" ? "" : badge)}</b>` : ""}</span>
                  <span class="folder-label">${escapeHtml(a.name || baseName(a.path || a.id))}</span>
                  <i class="folder-dot"></i>
                </button>`;
              })
              .join("")}</div>
            <p class="folder-hint">${t("Drag an app onto another on the dock to make a folder, or onto this folder to add it.")}</p>`;
          body.querySelectorAll(".folder-app").forEach((b) => paintIcon(b.querySelector("img"), iconKeyOf(folder.apps[Number(b.dataset.i)]), icon("window")));
          const input = body.querySelector(".folder-name");
          if (rename) setTimeout(() => (input.focus(), input.select()), 60);
          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === "Escape") close();
          });
          let leave = null; // an app taken out, saved on close
          body.addEventListener("click", (ev) => {
            const b = ev.target.closest(".folder-app");
            if (!b) return;
            const a = folder.apps[Number(b.dataset.i)];
            const wins = windows.filter((w) => matches(a, w));
            close();
            if (!wins.length) {
              bounce(c, e.key);
              launchPin(a).catch(() => {});
            } else if (wins.length === 1) act(wins[0]);
            else act(wins.find((w) => w.active) ?? wins[wins.length - 1], "focus");
          });
          body.addEventListener("contextmenu", (ev) => {
            const b = ev.target.closest(".folder-app");
            if (!b) return;
            ev.preventDefault();
            ev.stopPropagation();
            leave = folder.apps[Number(b.dataset.i)];
            close();
          });
          // Renaming (and taking an app out) saves the folder, which rebuilds
          // the bar and closes pop-ups, so it happens once, on close.
          return () => {
            const name = input.value.trim() || t("Folder");
            if (leave) setTimeout(() => takeOutMenu(c, e, leave, name), 0);
            else if (name !== folder.name) setTimeout(() => saveFolder(folder, { ...folder, name }), 0);
          };
        },
      });
    }

    /** Right-click on an app inside a folder (whose name may have just been
     * edited to `name`). */
    function takeOutMenu(c, e, app, name) {
      ctx.openMenu(c, [
        { header: app.name || baseName(app.path || app.id) },
        { label: t("Open"), icon: "rocket", action: () => launchPin(app).catch(() => {}) },
        { label: t("Run as administrator"), icon: "shield", action: () => launchPin(app, true).catch(() => {}) },
        "-",
        { label: t("Take out of the folder"), icon: "up", action: () => takeOut(e, app, name) },
        {
          label: t("Unpin from the dock"),
          icon: "unpin",
          danger: true,
          action: () => saveFolder(e.pin, { ...e.pin, name, apps: e.pin.apps.filter((a) => a !== app) }),
        },
      ]);
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
      // Held over the middle of another icon: dropping makes a folder (or
      // puts it into that folder), as on a phone.
      // It arms after a short hold, so passing over icons only reorders.
      const over = folderTargetAt(ev.clientX, drag.c);
      if (over !== drag.over) {
        clearTimeout(drag.armTimer);
        drag.over?.classList.remove("is-drop-target");
        drag.over = over;
        drag.armed = false;
        if (over) {
          const d = drag;
          d.armTimer = setTimeout(() => {
            if (drag !== d || d.over !== over) return;
            d.armed = true;
            over.classList.add("is-drop-target");
          }, 350);
        }
      }
    });

    /** The icon whose middle is under `x`, if the dragged one can go into it. */
    function folderTargetAt(x, dragged) {
      if (entryOf(dragged)?.folder) return null;
      for (const cell of el.querySelectorAll(".cell:not(.is-leaving)")) {
        if (cell === dragged) continue;
        const r = cell.getBoundingClientRect();
        if (x > r.left + r.width * 0.25 && x < r.right - r.width * 0.25) return cell;
      }
      return null;
    }
    const endDrag = (ev) => {
      if (!drag) return;
      const { c, moved, over, armed, armTimer } = drag;
      clearTimeout(armTimer);
      drag = null;
      if (!moved) return;
      c.classList.remove("is-dragging");
      c.style.transform = "";
      ctx.setMagnifyPaused(false);
      over?.classList.remove("is-drop-target");
      c._dragged = true;
      setTimeout(() => (c._dragged = false), 50);
      if (over && armed && ev.type === "pointerup") return mergeInto(entryOf(c), entryOf(over));
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
