// System meters, network speed, battery, Recycle Bin, power menu and the
// background (tray) apps.

import { call, inTauri } from "../../lib/tauri.js";
import { icon } from "../../lib/icons.js";
import { t } from "../../lib/i18n.js";
import { escapeHtml, formatBytes, formatSpeed } from "../../lib/util.js";
import { subscribeStats, getIcon } from "../data.js";
import { demo } from "../demo.js";

const R = 9;
const CIRC = 2 * Math.PI * R;

function ring(value, label, cls) {
  const v = Math.max(0, Math.min(100, value || 0));
  return `<span class="ring ${cls} ${v > 85 ? "is-hot" : ""}" title="${label}">
    <svg viewBox="0 0 24 24"><circle class="ring-bg" cx="12" cy="12" r="${R}"/><circle class="ring-fg" cx="12" cy="12" r="${R}" style="stroke-dasharray:${CIRC};stroke-dashoffset:${CIRC * (1 - v / 100)}"/></svg>
    <span class="ring-v">${Math.round(v)}</span></span>`;
}

function bar(value, label, cls) {
  const v = Math.max(0, Math.min(100, value || 0));
  return `<span class="mbar ${cls} ${v > 85 ? "is-hot" : ""}"><span class="mbar-l">${label}</span><span class="mbar-track"><i style="width:${v}%"></i></span></span>`;
}

const diskUse = (s) => {
  const c = s.drives?.[0];
  return c ? ((c.total - c.free) / c.total) * 100 : 0;
};

function uptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? t("{d}d {h}h", { d, h }) : t("{h}h {m}m", { h, m });
}

function statsPanel(anchor, ctx) {
  ctx.openPopup(anchor, {
    width: 340,
    className: "stats-pop",
    build(body) {
      const row = (label, value, pct, sub) => `<div class="sp-row ${pct > 85 ? "is-hot" : ""}">
          <div class="sp-head"><span>${label}</span><b>${value}</b></div>
          <div class="sp-track"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
          ${sub ? `<div class="sp-sub">${sub}</div>` : ""}</div>`;
      const off = subscribeStats((s) => {
        if (!s) return;
        body.innerHTML = `<div class="pop-title">${t("System")}</div>
          ${row(t("Processor"), `${Math.round(s.cpu)}%`, s.cpu)}
          ${row(t("Memory"), `${Math.round(s.memory)}%`, s.memory, `${formatBytes(s.memoryUsed)} / ${formatBytes(s.memoryTotal)}`)}
          ${(s.drives || []).map((d) => row(`${t("Disk")} ${d.name}`, `${Math.round(((d.total - d.free) / d.total) * 100)}%`, ((d.total - d.free) / d.total) * 100, t("{free} free of {total}", { free: formatBytes(d.free), total: formatBytes(d.total) }))).join("")}
          <div class="sp-facts">
            <span>${icon("down")} ${formatSpeed(s.netDown)}</span>
            <span>${icon("up")} ${formatSpeed(s.netUp)}</span>
            ${s.battery != null ? `<span>${icon(s.charging ? "bolt" : "battery")} ${s.battery}%</span>` : ""}
            <span>${icon("clock")} ${uptime(s.uptimeSecs)}</span>
          </div>`;
      }, 1000);
      return off;
    },
  });
}

export const stats = {
  render(el, item, ctx) {
    const o = item.opts;
    el.innerHTML = `<button class="stats is-${o.style}"></button>`;
    const b = el.firstChild;
    const off = subscribeStats((s) => {
      if (!s) return;
      const parts = [];
      const add = (on, v, label, cls) => {
        if (!on) return;
        if (o.style === "ring") parts.push(ring(v, label, cls));
        else if (o.style === "bar") parts.push(bar(v, label, cls));
        else parts.push(`<span class="mtext ${v > 85 ? "is-hot" : ""}"><em>${label}</em>${Math.round(v)}%</span>`);
      };
      add(o.cpu, s.cpu, "CPU", "cpu");
      add(o.ram, s.memory, "RAM", "ram");
      add(o.disk, diskUse(s), t("Disk"), "disk");
      b.innerHTML = parts.join("");
      ctx.layoutChanged();
    }, o.interval * 1000);
    b.addEventListener("click", () => statsPanel(b, ctx));
    return { destroy: off };
  },
};

export const network = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="net"><span class="net-d"></span><span class="net-u"></span></button>`;
    const b = el.firstChild;
    const off = subscribeStats((s) => {
      if (!s) return;
      b.classList.toggle("is-offline", !s.online);
      b.querySelector(".net-d").innerHTML = s.online ? `${icon("down")}${formatSpeed(s.netDown)}` : `${icon("wifi")}${t("Offline")}`;
      b.querySelector(".net-u").innerHTML = item.opts.up && s.online ? `${icon("up")}${formatSpeed(s.netUp)}` : "";
      ctx.layoutChanged();
    }, 1000);
    b.addEventListener("click", () => statsPanel(b, ctx));
    return { destroy: off };
  },
};

let battIds = 0;

/** The battery drawing: outline, cap, fill to `pct`, and a bolt (cut out of
 * the rest) while charging. */
function batterySvg(pct, charging) {
  const id = `bm${++battIds}`;
  const w = Math.max(pct > 0 ? 1.5 : 0, (19 * Math.min(100, Math.max(0, pct))) / 100);
  const bolt = "M13.6 1.6 8.4 7.6h3.6l-1.6 4.8 5.4-6.2h-3.7z";
  return `<svg class="batt-svg" viewBox="0 0 26 13" aria-hidden="true">
    ${charging ? `<mask id="${id}"><rect x="-2" y="-2" width="30" height="17" fill="#fff"/><path d="${bolt}" fill="#000" stroke="#000" stroke-width="2.4" stroke-linejoin="round"/></mask>` : ""}
    <g ${charging ? `mask="url(#${id})"` : ""}>
      <rect class="b-shell" x="0.7" y="0.7" width="22.1" height="11.6" rx="3.4"/>
      <rect class="b-cap" x="23.8" y="4.3" width="1.9" height="4.4" rx="0.9"/>
      <rect class="b-fill" x="2.3" y="2.3" width="${w.toFixed(2)}" height="8.4" rx="1.8"/>
    </g>
    ${charging ? `<path class="b-bolt" d="${bolt}"/>` : ""}
  </svg>`;
}

export const battery = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="batt"></button>`;
    const b = el.firstChild;
    const off = subscribeStats((s) => {
      if (!s) return;
      el.hidden = s.battery == null;
      if (s.battery == null) return ctx.layoutChanged();
      const low = s.battery <= 15 && !s.charging;
      const mid = !low && s.battery <= 30 && !s.charging;
      b.className = `batt ${low ? "is-low" : ""} ${mid ? "is-mid" : ""} ${s.charging ? "is-charging" : ""}`;
      b.innerHTML = `${batterySvg(s.battery, s.charging)}${item.opts.percent ? `<span class="batt-pct">${s.battery}%</span>` : ""}`;
      b._tip = `${t("Battery")} ${s.battery}%${s.charging ? ` · ${t("charging")}` : ""}`;
      ctx.layoutChanged();
    }, 5000);
    b.addEventListener("pointerenter", () => ctx.showTip(b, b._tip));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => statsPanel(b, ctx));
    return { destroy: off };
  },
};

export const recycle = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn recycle" data-mag>${icon("trash")}<i class="dot"></i></button>`;
    const b = el.firstChild;
    let info = { items: 0, bytes: 0 };
    const read = async () => {
      info = inTauri ? ((await call("recycle_bin").catch(() => null)) ?? info) : { items: 12, bytes: 3.2e8 };
      b.classList.toggle("is-full", info.items > 0);
      b._tip = info.items ? t("Recycle Bin: {n} items, {size}", { n: info.items, size: formatBytes(info.bytes) }) : t("Recycle Bin is empty");
    };
    read();
    const timer = setInterval(read, 15000);
    b.addEventListener("pointerenter", () => {
      read();
      ctx.showTip(b, b._tip);
    });
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => call("launch", { target: "shell:RecycleBinFolder" }).catch(() => {}));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      ctx.openMenu(b, [
        { header: b._tip },
        { label: t("Open"), icon: "folder", action: () => call("launch", { target: "shell:RecycleBinFolder" }).catch(() => {}) },
        { label: t("Empty Recycle Bin"), icon: "trash", danger: true, disabled: !info.items, action: () => call("empty_recycle_bin").then(read).catch(() => {}) },
      ]);
    });
    return { destroy: () => clearInterval(timer) };
  },
};

export const power = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn" data-mag>${icon("power")}</button>`;
    const b = el.firstChild;
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Power")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 260,
        className: "power-pop",
        build(body, close) {
          const actions = [
            ["lock", "lock", t("Lock")],
            ["sleep", "moon", t("Sleep")],
            ["signout", "logout", t("Sign out")],
            ["restart", "restart", t("Restart")],
            ["shutdown", "power", t("Shut down")],
          ];
          // Restart and shut down ask once more, right there.
          let armed = null;
          const paint = () => {
            body.innerHTML = `<div class="pop-title">${t("Power")}</div>${actions
              .map(
                ([id, ic, label]) =>
                  `<button class="pw ${armed === id ? "is-armed" : ""} ${id === "shutdown" ? "is-danger" : ""}" data-pw="${id}">${icon(ic)}<span>${armed === id ? t("Click again to confirm") : label}</span></button>`
              )
              .join("")}`;
          };
          paint();
          body.addEventListener("click", (e) => {
            const p = e.target.closest("[data-pw]");
            if (!p) return;
            const id = p.dataset.pw;
            if (["restart", "shutdown", "signout"].includes(id) && armed !== id) {
              armed = id;
              return paint();
            }
            close();
            call("power", { action: id }).catch(() => {});
          });
        },
      });
    });
    return {};
  },
};

export const tray = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn tray-btn" data-mag>${icon("tray")}</button>`;
    const b = el.firstChild;
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Background apps")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 300,
        className: "tray-pop",
        build(body, close) {
          body.innerHTML = `<div class="pop-title">${t("Background apps")}</div><div class="tray-grid"><p class="hint">${t("Loading…")}</p></div>`;
          let alive = true;
          (inTauri ? call("tray_apps") : Promise.resolve(demo.tray))
            .then((list) => {
              if (!alive) return;
              const grid = body.querySelector(".tray-grid");
              if (!list?.length) {
                grid.innerHTML = `<p class="hint">${t("No background apps right now.")}</p>`;
                return;
              }
              grid.innerHTML = list
                .map((a, i) => `<button class="tray-app" data-i="${i}" title="${escapeHtml(a.name)}"><img alt="" hidden /><span>${escapeHtml(a.name)}</span></button>`)
                .join("");
              grid.querySelectorAll(".tray-app").forEach((btn) => {
                const a = list[Number(btn.dataset.i)];
                const img = btn.querySelector("img");
                if (a.icon) {
                  img.src = a.icon;
                  img.hidden = false;
                } else {
                  getIcon(a.path).then((src) => {
                    if (src) {
                      img.src = src;
                      img.hidden = false;
                    }
                  });
                }
                btn.addEventListener("click", () => {
                  close();
                  call("launch", { target: a.path }).catch(() => {});
                });
              });
              ctx.repositionPopup();
            })
            .catch(() => {});
          return () => (alive = false);
        },
      });
    });
    return {};
  },
};
