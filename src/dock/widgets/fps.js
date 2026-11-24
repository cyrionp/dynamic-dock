// FPS counter. Rust measures (once a second, only while it runs) and draws
// the counter over games; this widget starts and stops it and shows the
// number on the dock. See src-tauri/src/fps for how frames are counted.

import { call, on, inTauri } from "../../lib/tauri.js";
import { icon } from "../../lib/icons.js";
import { t } from "../../lib/i18n.js";
import { escapeHtml } from "../../lib/util.js";

const STOPPED = { running: false, fps: 0, source: "", app: "", overlay: false, moving: false, gameCapture: null, supported: true };

/* ---------- shared state ---------- */

let state = { ...STOPPED };
const subs = new Set();
let started = false;
let demoTimer = 0;

function set(next) {
  state = { ...STOPPED, ...next };
  for (const fn of subs) fn(state);
}

function subscribe(fn) {
  if (!started) {
    started = true;
    if (inTauri) {
      on("fps://state", set);
      call("fps_state").then((s) => s && set(s)).catch(() => {});
    }
  }
  subs.add(fn);
  fn(state);
  return () => subs.delete(fn);
}

// Outside the app (`npm run dev`) a made-up number, so the UI can be worked on.
function demo(patch) {
  const next = { ...state, ...patch };
  if (patch.overlay) next.running = true;
  if (patch.running === false) Object.assign(next, { fps: 0, source: "", overlay: false, moving: false });
  if (!next.overlay) next.moving = false;
  clearInterval(demoTimer);
  if (next.running) {
    demoTimer = setInterval(() => set({ ...state, fps: 110 + Math.round(Math.random() * 40), source: "game", app: "game.exe" }), 1000);
  }
  set(next);
}

const setRunning = (on) => (inTauri ? call("fps_set_running", { on }) : demo({ running: on }));
const setOverlay = (on) => (inTauri ? call("fps_set_overlay", { on }) : demo({ overlay: on }));
const setMoving = (on) => (inTauri ? call("fps_set_moving", { on }) : demo({ moving: on }));

/** good / ok / low, for the colour. */
const grade = (fps) => (fps >= 60 ? "is-good" : fps >= 30 ? "is-ok" : fps > 0 ? "is-low" : "");

function sourceText(s) {
  if (!s.running) return t("Stopped");
  if (s.source === "game") return s.app ? t("Game: {app}", { app: escapeHtml(s.app) }) : t("The app in front");
  if (s.source === "screen") return t("Screen (approximate)");
  return t("Measuring…");
}

/* ---------- the widget ---------- */

export const fps = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="chip fps"><span class="chip-ic">${icon("gauge")}</span><span class="chip-t"></span></button>`;
    const b = el.firstChild;
    const label = b.querySelector(".chip-t");
    const off = subscribe((s) => {
      b.classList.toggle("is-live", s.running);
      b.dataset.grade = grade(s.fps);
      const text = s.running ? `${s.fps} FPS` : "";
      if (label.textContent !== text) {
        label.textContent = text;
        ctx.layoutChanged();
      }
    });
    b.addEventListener("pointerenter", () => ctx.showTip(b, state.running ? t("FPS counter · {src}", { src: sourceText(state) }) : t("FPS counter")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    // Middle click starts or stops it without the panel.
    b.addEventListener("auxclick", (e) => {
      if (e.button === 1) setRunning(!state.running);
    });
    b.addEventListener("click", () => panel(b, ctx));
    return { destroy: off };
  },
};

function panel(anchor, ctx) {
  let asked = false;
  ctx.openPopup(anchor, {
    width: 320,
    className: "fps-pop",
    build(body) {
      const paint = (s) => {
        const keys = ctx.hotkeys || {};
        const hk = [
          keys.toggleFps && t("{key} starts or stops", { key: escapeHtml(keys.toggleFps) }),
          keys.toggleFpsOverlay && t("{key} shows or hides it on the screen", { key: escapeHtml(keys.toggleFpsOverlay) }),
        ].filter(Boolean);
        body.innerHTML = `<div class="pop-title"><span>${t("FPS counter")}</span></div>
          <div class="fps-big ${grade(s.fps)}"><b>${s.fps}</b><small>FPS</small></div>
          <div class="fps-src">${sourceText(s)}</div>
          <div class="fps-actions">
            <button class="btn-primary" data-run>${icon(s.running ? "pause" : "play")}${s.running ? t("Stop") : t("Start")}</button>
            <button class="chip-btn ${s.overlay ? "is-on" : ""}" data-overlay>${icon("window")}${s.overlay ? t("Hide from the screen") : t("Show on the screen")}</button>
          </div>
          ${
            s.overlay
              ? `<div class="fps-actions"><button class="chip-btn ${s.moving ? "is-on" : ""}" data-move>${icon(s.moving ? "check" : "drag")}${s.moving ? t("Done") : t("Move")}</button></div>
                 <p class="hint">${s.moving ? t("Drag the counter anywhere on the screen, then double-click it or press Done.") : t("Clicks go through it, so it never gets in the game's way.")}</p>`
              : ""
          }
          ${
            s.gameCapture === false
              ? `<div class="fps-note"><p class="hint">${t("Showing the screen's frame rate. To count each game's own frames, Windows has to allow the dock to read them (as it does for the Xbox Game Bar).")}</p>
                 ${asked ? `<p class="hint">${t("Approved? Sign out of Windows and back in, then start the counter again.")}</p>` : `<button class="chip-btn" data-allow>${icon("shield")}${t("Allow per-game counting")}</button>`}</div>`
              : ""
          }
          <p class="hint">${t("Shows over games in a window or borderless full screen. Exclusive full screen hides everything else; switch the game to borderless to see the counter there.")}</p>
          ${hk.length ? `<p class="hint">${t("Shortcuts")}: ${hk.join(" · ")}</p>` : ""}`;
        ctx.repositionPopup();
      };
      const off = subscribe(paint);
      body.addEventListener("click", (e) => {
        if (e.target.closest("[data-run]")) setRunning(!state.running);
        else if (e.target.closest("[data-overlay]")) setOverlay(!state.overlay);
        else if (e.target.closest("[data-move]")) setMoving(!state.moving);
        else if (e.target.closest("[data-allow]")) {
          call("fps_enable_game_capture")
            .then(() => {
              asked = true;
              paint(state);
            })
            .catch(() => {});
        }
      });
      return off;
    },
  });
}
