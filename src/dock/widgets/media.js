// Now playing (any player Windows knows about) and the volume.

import { call } from "../../lib/tauri.js";
import { icon } from "../../lib/icons.js";
import { t } from "../../lib/i18n.js";
import { escapeHtml, formatDuration } from "../../lib/util.js";
import { media as mediaSource, volume as volumeSource, audio as audioSource, changeVolume } from "../data.js";

const control = (action) => call("media_control", { action }).catch(() => {});

/** Where the track is now; while playing it moves on by itself. */
function position(m) {
  const { positionMs = 0, durationMs = 0 } = m.timeline ?? {};
  const now = positionMs + (m.playing ? Date.now() - (m.at || Date.now()) : 0);
  return durationMs ? Math.min(now, durationMs) : now;
}

function prettySource(src) {
  const s = String(src || "").replace(/\.exe$/i, "").split(/[!\\.]/).filter(Boolean);
  return s.length ? s[s.length - 1] : t("Media");
}

const cover = (m, cls) =>
  m.thumbnail ? `<img class="${cls}" src="${m.thumbnail}" alt="" draggable="false" />` : `<span class="${cls} is-empty">${icon("music")}</span>`;

const VOLUME_STEP = 0.02;

function wheelVolume(el) {
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      changeVolume({ delta: e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP });
    },
    { passive: false }
  );
}

export const media = {
  render(el, item, ctx) {
    const o = item.opts;
    let m = { hasSession: false };
    let key = "";
    const paint = () => {
      const show = m.hasSession && (m.title || m.artist || m.source);
      el.hidden = Boolean(o.hideIdle && !show);
      const k = JSON.stringify([show, m.title, m.artist, m.playing, Boolean(m.thumbnail), m.thumbnail?.length]);
      if (k === key) return;
      key = k;
      if (!show) {
        el.innerHTML = `<button class="btn media-idle" data-mag>${icon("music")}</button>`;
        el.firstChild.addEventListener("pointerenter", () => ctx.showTip(el.firstChild, t("Nothing is playing")));
        el.firstChild.addEventListener("pointerleave", () => ctx.hideTip());
        ctx.layoutChanged();
        return;
      }
      const title = [m.title, m.artist].filter(Boolean).join(" · ") || prettySource(m.source);
      el.innerHTML = `<div class="media ${m.playing ? "is-playing" : ""}">
          ${o.cover ? `<button class="media-cover" data-open>${cover(m, "media-art")}${m.playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ""}</button>` : ""}
          ${o.title ? `<button class="media-title" data-open style="max-width:${o.width}px"><span class="marquee"><span>${escapeHtml(title)}</span></span></button>` : ""}
          ${
            o.controls
              ? `<span class="media-ctl">
              <button class="icon-btn" data-act="previous" aria-label="${t("Previous")}">${icon("previous")}</button>
              <button class="icon-btn is-main" data-act="toggle" aria-label="${m.playing ? t("Pause") : t("Play")}">${icon(m.playing ? "pause" : "play")}</button>
              <button class="icon-btn" data-act="next" aria-label="${t("Next")}">${icon("next")}</button>
            </span>`
              : ""
          }
        </div>`;
      // Long titles scroll slowly while hovered.
      const mq = el.querySelector(".marquee");
      if (mq) {
        requestAnimationFrame(() => {
          const over = mq.firstChild.scrollWidth - mq.clientWidth;
          mq.classList.toggle("is-long", over > 2);
          mq.style.setProperty("--over", `${-over - 8}px`);
          mq.style.setProperty("--dur", `${Math.max(4, over / 25)}s`);
        });
      }
      ctx.layoutChanged();
    };
    const off = mediaSource.subscribe((v) => {
      m = v;
      paint();
    });
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) return control(act.dataset.act);
      const open = e.target.closest("[data-open], .media-idle");
      if (open) openMediaPanel(open, ctx);
    });
    wheelVolume(el);
    paint();
    return { destroy: off };
  },
};

function openMediaPanel(anchor, ctx) {
  ctx.openPopup(anchor, {
    width: 340,
    className: "media-pop",
    build(body) {
      let m = mediaSource.value;
      let timer = 0;
      const paint = () => {
        if (!m.hasSession) {
          body.innerHTML = `<div class="empty">${icon("music")}<p>${t("Nothing is playing")}</p><p class="hint">${t("Start music in any player: Spotify, a browser, Apple Music…")}</p></div>`;
          return;
        }
        const dur = m.timeline?.durationMs || 0;
        body.innerHTML = `<div class="mp-top">
            ${cover(m, "mp-art")}
            <div class="mp-meta"><div class="mp-title">${escapeHtml(m.title || prettySource(m.source))}</div>
            <div class="mp-artist">${escapeHtml(m.artist || "")}</div>
            <div class="mp-src">${escapeHtml(prettySource(m.source))}</div></div>
          </div>
          ${dur ? `<div class="mp-seek"><span class="mp-pos">0:00</span><input class="range" type="range" min="0" max="${dur}" step="1000" value="0" /><span>${formatDuration(dur)}</span></div>` : ""}
          <div class="mp-ctl">
            <button class="icon-btn" data-act="previous" aria-label="${t("Previous")}">${icon("previous")}</button>
            <button class="icon-btn is-big" data-act="toggle">${icon(m.playing ? "pause" : "play")}</button>
            <button class="icon-btn" data-act="next" aria-label="${t("Next")}">${icon("next")}</button>
          </div>`;
        tick();
      };
      let dragging = false;
      const tick = () => {
        clearTimeout(timer);
        const range = body.querySelector(".range");
        if (range && !dragging) {
          const p = position(m);
          range.value = String(p);
          range.style.setProperty("--fill", `${(p / Number(range.max)) * 100}%`);
          body.querySelector(".mp-pos").textContent = formatDuration(p);
        }
        if (m.playing) timer = setTimeout(tick, 1000);
      };
      const off = mediaSource.subscribe((v) => {
        const changed = v.title !== m.title || v.playing !== m.playing || v.thumbnail !== m.thumbnail || v.hasSession !== m.hasSession;
        m = v;
        if (changed) paint();
        else tick();
      });
      body.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]");
        if (act) control(act.dataset.act);
      });
      body.addEventListener("input", (e) => {
        if (!e.target.matches(".range")) return;
        dragging = true;
        e.target.style.setProperty("--fill", `${(Number(e.target.value) / Number(e.target.max)) * 100}%`);
        body.querySelector(".mp-pos").textContent = formatDuration(Number(e.target.value));
      });
      body.addEventListener("change", (e) => {
        if (!e.target.matches(".range")) return;
        dragging = false;
        call("media_seek", { positionMs: Number(e.target.value) }).catch(() => {});
      });
      paint();
      return () => {
        off();
        clearTimeout(timer);
      };
    },
  });
}

/* ---------- volume ---------- */

const volumeIcon = (v) => icon(v.muted || v.level === 0 ? "mute" : v.level < 0.4 ? "volumeLow" : "volume");

export const volume = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn volume" data-mag><span class="vol-ic"></span><span class="vol-pct"></span></button>`;
    const b = el.firstChild;
    let last = "";
    const off = volumeSource.subscribe((v) => {
      const k = `${v.muted}|${Math.round(v.level * 100)}`;
      if (k === last) return;
      last = k;
      b.querySelector(".vol-ic").innerHTML = volumeIcon(v);
      b.querySelector(".vol-pct").textContent = item.opts.percent ? `${Math.round(v.level * 100)}%` : "";
      b._tip = v.muted ? t("Muted") : `${t("Volume")} ${Math.round(v.level * 100)}%`;
      ctx.layoutChanged();
    });
    wheelVolume(b);
    b.addEventListener("pointerenter", () => ctx.showTip(b, b._tip));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("auxclick", (e) => {
      if (e.button === 1) changeVolume({ mute: !volumeSource.value.muted });
    });
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 320,
        className: "volume-pop",
        build(body) {
          const paint = (v) => {
            const pct = Math.round(v.level * 100);
            const range = body.querySelector(".range");
            if (range) {
              if (document.activeElement !== range) range.value = String(pct);
              range.style.setProperty("--fill", `${pct}%`);
              body.querySelector(".vp-mute").innerHTML = volumeIcon(v);
              body.querySelector(".vp-pct").textContent = `${pct}%`;
            }
          };
          const devicesHtml = (a) =>
            (a.devices || [])
              .map(
                (d) => `<button class="dev ${d.isDefault ? "is-on" : ""}" data-dev="${escapeHtml(d.id)}">
                  ${icon(d.kind === "headphones" || d.kind === "headset" ? "headphones" : "speaker")}
                  <span>${escapeHtml(d.name)}</span>${d.battery != null ? `<em>${d.battery}%</em>` : ""}</button>`
              )
              .join("");
          body.innerHTML = `<div class="pop-title">${t("Sound")}</div>
            <div class="vp-row"><button class="icon-btn vp-mute" aria-label="${t("Mute")}"></button>
            <input class="range" type="range" min="0" max="100" step="1" /><span class="vp-pct"></span></div>
            <div class="pop-sub">${t("Output")}</div><div class="devs"></div>`;
          const offV = volumeSource.subscribe(paint);
          const offA = audioSource.subscribe((a) => {
            body.querySelector(".devs").innerHTML = devicesHtml(a) || `<p class="hint">${t("No output devices found")}</p>`;
          });
          body.addEventListener("input", (e) => {
            if (e.target.matches(".range")) changeVolume({ level: Number(e.target.value) / 100 });
          });
          wheelVolume(body.querySelector(".vp-row"));
          body.addEventListener("click", (e) => {
            if (e.target.closest(".vp-mute")) changeVolume({ mute: !volumeSource.value.muted });
            const dev = e.target.closest("[data-dev]");
            if (dev) call("audio_set_default", { id: dev.dataset.dev }).catch(() => {});
          });
          return () => {
            offV();
            offA();
          };
        },
      });
    });
    return { destroy: off };
  },
};
