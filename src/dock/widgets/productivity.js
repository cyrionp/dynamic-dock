// Stopwatches, timers, notes and a to-do list. Their data stays in this
// computer's local storage. Nothing ticks unless something is running.

import { icon } from "../../lib/icons.js";
import { t } from "../../lib/i18n.js";
import { escapeHtml, formatDuration, formatElapsed, debounce } from "../../lib/util.js";
import { load, save, newId } from "../../lib/store.js";

/* ---------- a tiny shared store with change listeners ---------- */

function collection(key) {
  const subs = new Set();
  const c = {
    items: load(key, []),
    set(items) {
      c.items = items;
      save(key, items);
      for (const fn of subs) fn(items);
    },
    update(id, patch) {
      c.set(c.items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    },
    remove(id) {
      c.set(c.items.filter((x) => x.id !== id));
    },
    subscribe(fn) {
      subs.add(fn);
      fn(c.items);
      return () => subs.delete(fn);
    },
  };
  return c;
}

const stopwatches = collection("stopwatches");
const timers = collection("timers");
const notes = collection("notes");
const todos = collection("todos");

/** Re-runs `fn` every `ms` while `active()` says so. */
function ticker(fn, ms, active) {
  let timer = 0;
  const run = () => {
    clearTimeout(timer);
    fn();
    if (active()) timer = setTimeout(run, ms - (Date.now() % ms));
  };
  return { run, stop: () => clearTimeout(timer) };
}

/* ---------- stopwatch ---------- */

const elapsed = (s) => (s.running ? s.accumulated + (Date.now() - s.startedAt) : s.accumulated);

export const stopwatch = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="chip sw"><span class="chip-ic">${icon("stopwatch")}</span><span class="chip-t"></span></button>`;
    const b = el.firstChild;
    const label = b.querySelector(".chip-t");
    const tick = ticker(
      () => {
        const running = stopwatches.items.filter((s) => s.running);
        b.classList.toggle("is-live", running.length > 0);
        const top = running.sort((a, c) => elapsed(c) - elapsed(a))[0];
        const text = top ? formatElapsed(elapsed(top)).replace(/\.\d$/, "") : "";
        if (label.textContent !== text) {
          label.textContent = text;
          ctx.layoutChanged();
        }
      },
      1000,
      () => stopwatches.items.some((s) => s.running)
    );
    const off = stopwatches.subscribe(() => tick.run());
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Stopwatch")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 320,
        className: "sw-pop",
        build(body) {
          const paint = () => {
            const list = stopwatches.items;
            body.innerHTML = `<div class="pop-title">${t("Stopwatches")}<button class="icon-btn" data-add aria-label="${t("Add")}">${icon("plus")}</button></div>
              ${list.length ? "" : `<p class="hint">${t("Add a stopwatch with +.")}</p>`}
              ${list
                .map(
                  (s) => `<div class="sw-row ${s.running ? "is-live" : ""}" data-id="${s.id}">
                    <div><div class="sw-name">${escapeHtml(s.name)}</div><div class="sw-time" data-time>${formatElapsed(elapsed(s))}</div></div>
                    <div class="sw-btns">
                      <button class="icon-btn is-main" data-toggle>${icon(s.running ? "pause" : "play")}</button>
                      <button class="icon-btn" data-reset aria-label="${t("Reset")}">${icon("reset")}</button>
                      <button class="icon-btn" data-del aria-label="${t("Delete")}">${icon("close")}</button>
                    </div></div>`
                )
                .join("")}`;
            ctx.repositionPopup();
          };
          const fast = ticker(
            () => body.querySelectorAll(".sw-row").forEach((row) => {
              const s = stopwatches.items.find((x) => String(x.id) === row.dataset.id);
              if (s) row.querySelector("[data-time]").textContent = formatElapsed(elapsed(s));
            }),
            100,
            () => stopwatches.items.some((s) => s.running)
          );
          const off2 = stopwatches.subscribe(() => {
            paint();
            fast.run();
          });
          body.addEventListener("click", (e) => {
            if (e.target.closest("[data-add]")) {
              const n = stopwatches.items.length + 1;
              stopwatches.set([...stopwatches.items, { id: newId(), name: t("Stopwatch {n}", { n }), running: true, startedAt: Date.now(), accumulated: 0 }]);
              return;
            }
            const row = e.target.closest("[data-id]");
            if (!row) return;
            const s = stopwatches.items.find((x) => String(x.id) === row.dataset.id);
            if (!s) return;
            if (e.target.closest("[data-toggle]")) {
              stopwatches.update(s.id, s.running ? { running: false, accumulated: elapsed(s) } : { running: true, startedAt: Date.now() });
            } else if (e.target.closest("[data-reset]")) {
              stopwatches.update(s.id, { accumulated: 0, startedAt: Date.now() });
            } else if (e.target.closest("[data-del]")) {
              stopwatches.remove(s.id);
            }
          });
          return () => {
            off2();
            fast.stop();
          };
        },
      });
    });
    return {
      destroy() {
        off();
        tick.stop();
      },
    };
  },
};

/* ---------- timers ---------- */

const remaining = (x) => (x.running ? Math.max(0, x.endsAt - Date.now()) : x.remainingMs);

let audioCtx = null;
function chime() {
  try {
    audioCtx ??= new AudioContext();
    const now = audioCtx.currentTime;
    [880, 1175, 1568].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.9);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 1);
    });
  } catch {
    // no sound, no problem
  }
}

/** Marks timers that ran out; true when one just did. */
function settleTimers() {
  let rang = false;
  const next = timers.items.map((x) => {
    if (x.running && x.endsAt <= Date.now()) {
      rang = true;
      return { ...x, running: false, remainingMs: 0, done: true, ringing: true };
    }
    return x;
  });
  if (rang) timers.set(next);
  return rang;
}

function parseLength(text) {
  const s = String(text).trim();
  // "18:30" (a clock time) or "25" (minutes) or "1:30:00" / "5:00" (length).
  const clock = /^(\d{1,2})[:.](\d{2})$/.exec(s);
  const num = /^(\d+(?:[.,]\d+)?)$/.exec(s);
  if (num) return Math.round(parseFloat(num[1].replace(",", ".")) * 60_000);
  if (clock && s.length <= 5) return null; // handled as "until"
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}

// Timers ring even while their bar isn't the one showing: one watcher
// sleeps until the next timer ends.
let soundOn = true;
let watchTimer = 0;
function watchTimers() {
  clearTimeout(watchTimer);
  const next = timers.items.filter((x) => x.running).sort((a, c) => a.endsAt - c.endsAt)[0];
  if (!next) return;
  watchTimer = setTimeout(() => {
    if (settleTimers() && soundOn) chime();
    watchTimers();
  }, Math.max(0, next.endsAt - Date.now()) + 20);
}
timers.subscribe(watchTimers);

export const countdown = {
  render(el, item, ctx) {
    soundOn = item.opts.sound;
    el.innerHTML = `<button class="chip cd"><span class="chip-ic">${icon("timer")}</span><span class="chip-t"></span></button>`;
    const b = el.firstChild;
    const label = b.querySelector(".chip-t");
    const tick = ticker(
      () => {
        const ringing = timers.items.some((x) => x.ringing);
        const running = timers.items.filter((x) => x.running).sort((a, c) => a.endsAt - c.endsAt);
        b.classList.toggle("is-live", running.length > 0);
        b.classList.toggle("is-ringing", ringing);
        b.classList.toggle("is-urgent", running[0] ? remaining(running[0]) <= 10_000 : false);
        const text = ringing ? t("Done!") : running[0] ? formatDuration(remaining(running[0])) : "";
        if (label.textContent !== text) {
          label.textContent = text;
          ctx.layoutChanged();
        }
      },
      1000,
      () => timers.items.some((x) => x.running)
    );
    const off = timers.subscribe(() => tick.run());
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Timer")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      // Opening it silences anything that rang.
      if (timers.items.some((x) => x.ringing)) timers.set(timers.items.map((x) => ({ ...x, ringing: false })));
      ctx.openPopup(b, {
        width: 330,
        className: "cd-pop",
        focus: true,
        build(body) {
          const start = (ms, name) => {
            if (!ms || ms <= 0) return;
            timers.set([...timers.items, { id: newId(), name: name || formatDuration(ms), duration: ms, running: true, endsAt: Date.now() + ms, remainingMs: ms, done: false }]);
          };
          const paint = () => {
            body.innerHTML = `<div class="pop-title">${t("Timers")}</div>
              <div class="cd-presets">${[1, 5, 10, 15, 25, 45, 60].map((m) => `<button class="chip-btn" data-min="${m}">${m < 60 ? `${m} ${t("min")}` : `1 ${t("h")}`}</button>`).join("")}</div>
              <form class="row-form"><input class="input" name="len" placeholder="${t("Minutes, 1:30:00 or until 18:30")}" autocomplete="off" /><input class="input is-small" name="name" placeholder="${t("Name")}" autocomplete="off" /><button class="btn-primary">${t("Start")}</button></form>
              <div class="cd-list">${timers.items
                .map(
                  (x) => `<div class="cd-row ${x.running ? "is-live" : ""} ${x.done ? "is-done" : ""}" data-id="${x.id}">
                    <div class="cd-meta"><div class="sw-name">${escapeHtml(x.name)}</div><div class="sw-time" data-time>${x.done ? t("Done") : formatDuration(remaining(x))}</div>
                    <div class="cd-prog"><i style="width:${x.duration ? (1 - remaining(x) / x.duration) * 100 : 0}%"></i></div></div>
                    <div class="sw-btns">
                      ${x.done ? `<button class="icon-btn" data-again aria-label="${t("Again")}">${icon("restart")}</button>` : `<button class="icon-btn is-main" data-toggle>${icon(x.running ? "pause" : "play")}</button>`}
                      <button class="icon-btn" data-del aria-label="${t("Delete")}">${icon("close")}</button>
                    </div></div>`
                )
                .join("")}</div>`;
            ctx.repositionPopup();
          };
          const live = ticker(
            () => {
              body.querySelectorAll(".cd-row").forEach((row) => {
                const x = timers.items.find((y) => String(y.id) === row.dataset.id);
                if (!x || x.done) return;
                row.querySelector("[data-time]").textContent = formatDuration(remaining(x));
                row.querySelector(".cd-prog i").style.width = `${x.duration ? (1 - remaining(x) / x.duration) * 100 : 0}%`;
              });
            },
            1000,
            () => timers.items.some((x) => x.running)
          );
          const off2 = timers.subscribe(() => {
            paint();
            live.run();
          });
          body.addEventListener("click", (e) => {
            const p = e.target.closest("[data-min]");
            if (p) return start(Number(p.dataset.min) * 60_000);
            const row = e.target.closest("[data-id]");
            if (!row) return;
            const x = timers.items.find((y) => String(y.id) === row.dataset.id);
            if (!x) return;
            if (e.target.closest("[data-toggle]")) {
              timers.update(x.id, x.running ? { running: false, remainingMs: remaining(x) } : { running: true, endsAt: Date.now() + x.remainingMs });
            } else if (e.target.closest("[data-again]")) {
              timers.update(x.id, { running: true, done: false, ringing: false, endsAt: Date.now() + x.duration, remainingMs: x.duration });
            } else if (e.target.closest("[data-del]")) {
              timers.remove(x.id);
            }
          });
          body.addEventListener("submit", (e) => {
            e.preventDefault();
            const f = e.target;
            const text = f.len.value.trim();
            const until = /^(\d{1,2})[:.](\d{2})$/.exec(text);
            let ms = null;
            let name = f.name.value.trim();
            if (until && (text.includes(":") || text.includes("."))) {
              const target = new Date();
              target.setHours(Number(until[1]), Number(until[2]), 0, 0);
              if (target <= new Date()) target.setDate(target.getDate() + 1);
              ms = target - Date.now();
              name ||= t("Until {time}", { time: `${until[1].padStart(2, "0")}:${until[2]}` });
            } else {
              ms = parseLength(text);
            }
            if (ms) start(ms, name);
          });
          setTimeout(() => body.querySelector("input")?.focus(), 60);
          return () => {
            off2();
            live.stop();
          };
        },
      });
    });
    return {
      destroy() {
        off();
        tick.stop();
      },
    };
  },
};

/* ---------- notes ---------- */

export const notesWidget = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn notes-btn" data-mag>${icon("note")}<i class="badge"></i></button>`;
    const b = el.firstChild;
    const off = notes.subscribe((list) => {
      b.querySelector(".badge").textContent = list.length ? String(list.length) : "";
    });
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("Notes")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 360,
        className: "notes-pop",
        focus: true,
        build(body) {
          let editing = null;
          const persist = debounce((id, text) => notes.update(id, { text, updated: Date.now() }), 300);
          const paint = () => {
            if (editing != null) {
              const n = notes.items.find((x) => x.id === editing);
              if (!n) {
                editing = null;
                return paint();
              }
              body.innerHTML = `<div class="pop-title"><button class="icon-btn" data-back aria-label="${t("Back")}">${icon("left")}</button><span>${t("Note")}</span>
                <button class="icon-btn" data-del aria-label="${t("Delete")}">${icon("trash")}</button></div>
                <textarea class="note-edit" placeholder="${t("Write something…")}">${escapeHtml(n.text)}</textarea>`;
              const ta = body.querySelector("textarea");
              ta.addEventListener("input", () => persist(n.id, ta.value));
              setTimeout(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = ta.value.length;
              }, 60);
            } else {
              const list = [...notes.items].sort((a, c) => (c.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || c.updated - a.updated);
              body.innerHTML = `<div class="pop-title">${t("Notes")}<button class="icon-btn" data-add aria-label="${t("New note")}">${icon("plus")}</button></div>
                ${list.length ? "" : `<p class="hint">${t("No notes yet. Add one with +.")}</p>`}
                <div class="note-list">${list
                  .map((n) => {
                    const [first, ...rest] = (n.text || t("Empty note")).split("\n");
                    return `<button class="note-card ${n.pinned ? "is-pinned" : ""}" data-id="${n.id}"><b>${escapeHtml(first)}</b><span>${escapeHtml(rest.join(" ").slice(0, 90))}</span>
                      <span class="note-pin" data-pin title="${t("Pin to top")}">${icon("pin")}</span></button>`;
                  })
                  .join("")}</div>`;
            }
            ctx.repositionPopup();
          };
          body.addEventListener("click", (e) => {
            if (e.target.closest("[data-add]")) {
              const id = newId();
              notes.set([...notes.items, { id, text: "", updated: Date.now() }]);
              editing = id;
              return paint();
            }
            if (e.target.closest("[data-back]")) {
              // Drop notes left empty.
              const n = notes.items.find((x) => x.id === editing);
              const ta = body.querySelector("textarea");
              if (n && !(ta?.value ?? n.text).trim()) notes.remove(n.id);
              else if (n && ta) notes.update(n.id, { text: ta.value, updated: Date.now() });
              editing = null;
              return paint();
            }
            if (e.target.closest("[data-del]")) {
              notes.remove(editing);
              editing = null;
              return paint();
            }
            const card = e.target.closest("[data-id]");
            if (!card) return;
            const id = Number(card.dataset.id);
            if (e.target.closest("[data-pin]")) {
              const n = notes.items.find((x) => x.id === id);
              notes.update(id, { pinned: !n?.pinned });
              return paint();
            }
            editing = id;
            paint();
          });
          paint();
          return () => {
            const ta = body.querySelector("textarea");
            if (editing != null && ta) {
              if (!ta.value.trim()) notes.remove(editing);
              else notes.update(editing, { text: ta.value, updated: Date.now() });
            }
          };
        },
      });
    });
    return { destroy: off };
  },
};

/* ---------- to-do ---------- */

export const todo = {
  render(el, item, ctx) {
    el.innerHTML = `<button class="btn todo-btn" data-mag>${icon("check")}<i class="badge"></i></button>`;
    const b = el.firstChild;
    const off = todos.subscribe((list) => {
      const open = list.filter((x) => !x.done).length;
      b.querySelector(".badge").textContent = open ? String(open) : "";
    });
    b.addEventListener("pointerenter", () => ctx.showTip(b, t("To-do")));
    b.addEventListener("pointerleave", () => ctx.hideTip());
    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 340,
        className: "todo-pop",
        focus: true,
        build(body) {
          const paint = () => {
            const list = todos.items;
            const done = list.filter((x) => x.done).length;
            body.innerHTML = `<div class="pop-title">${t("To-do")}${done ? `<button class="link" data-clear>${t("Clear done ({n})", { n: done })}</button>` : ""}</div>
              <form class="row-form"><input class="input" name="text" placeholder="${t("Add a task and press Enter")}" autocomplete="off" /></form>
              <div class="todo-list">${list
                .map(
                  (x) => `<div class="todo-row ${x.done ? "is-done" : ""}" data-id="${x.id}">
                    <button class="todo-check" data-toggle aria-label="${t("Done")}">${x.done ? icon("check") : ""}</button>
                    <span>${escapeHtml(x.text)}</span>
                    <button class="icon-btn" data-del aria-label="${t("Delete")}">${icon("close")}</button></div>`
                )
                .join("")}</div>`;
            ctx.repositionPopup();
            setTimeout(() => body.querySelector("input")?.focus(), 40);
          };
          const off2 = todos.subscribe(paint);
          body.addEventListener("submit", (e) => {
            e.preventDefault();
            const text = e.target.text.value.trim();
            if (text) todos.set([...todos.items, { id: newId(), text, done: false }]);
          });
          body.addEventListener("click", (e) => {
            if (e.target.closest("[data-clear]")) return todos.set(todos.items.filter((x) => !x.done));
            const row = e.target.closest("[data-id]");
            if (!row) return;
            const id = Number(row.dataset.id);
            if (e.target.closest("[data-toggle]")) {
              const x = todos.items.find((y) => y.id === id);
              todos.update(id, { done: !x?.done });
            } else if (e.target.closest("[data-del]")) todos.remove(id);
          });
          return off2;
        },
      });
    });
    return { destroy: off };
  },
};
