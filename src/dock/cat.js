// The dock cat: a small mascot that lives on top of the dock. It sits, walks
// from island to island (hopping over the gaps), grooms, yawns and curls up
// to sleep when left alone. It looks at the pointer, purrs when you rest the
// pointer on it, chases a pointer that darts past, does a trick when
// clicked and can be picked up and put somewhere else. Now and then it
// says something in a bubble or meows, and it notices the computer: a busy
// processor tires it out, a low battery worries it, music makes it dance.
//
// Light on purpose: no animation loop. Everything is a timer a few seconds
// apart plus CSS / Web Animations that the compositor runs, and a sleeping
// cat soon stops moving altogether. Every part can be turned off in
// Settings → Cat.

import "./cat.css";
import { CAT_SVG, FURS } from "./cat-art.js";
import { meow, purr } from "./cat-sound.js";
import { t } from "../lib/i18n.js";
import { subscribeStats, media as mediaSource } from "./data.js";

const W = 46; // px at size 1; the drawing is 64 × 48
const H = (W * 48) / 64;

// How often it talks or meows by itself, in minutes (from, to).
const RATES = { rare: [14, 28], sometimes: [5, 10], often: [1.5, 3.5] };

const IDLE_LINES = [
  "Meow!",
  "Pet me?",
  "I'm keeping an eye on your dock.",
  "Is it treat time yet?",
  "You're doing great today!",
  "Don't forget to drink some water.",
  "Mrrp?",
  "This dock is so warm.",
  "Can I sit on your keyboard?",
  "Purr…",
  "Have you saved your work?",
  "I like it here.",
];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const minutes = (rate) => (RATES[rate] || RATES.sometimes).map((m) => m * 60_000);

/**
 * Puts the cat on the dock. `host` gives it what it needs from the page:
 * { dock, bars, save(patch), hits(), menu(anchor, items), settings(), hidden(), top(), reduced() }.
 */
export function createCat(host) {
  const { dock, bars } = host;
  let opts = null;
  let el = null;
  let fx = null;
  let bubble = null;
  let x = 0;
  let facing = 1;
  let pose = "sit";
  let size = 1;
  let busy = false; // a trick or reaction is playing
  let held = false;
  let trip = 0; // bumps to cancel a walk in progress
  let moving = null; // [from, to] while walking, for the hit area
  let anim = null;
  let lastNear = Date.now();
  let lastPointer = { x: 0, t: 0 };
  let pounceAt = 0;
  let petting = 0;
  let tired = false;
  let lowBattery = false;
  let charging = null;
  let playing = false;
  const said = new Map(); // line → when, for cool-downs
  const timers = {};
  let offStats = null;
  let offMedia = null;

  const later = (name, ms, fn) => {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(fn, ms);
  };
  const stop = (name) => clearTimeout(timers[name]);
  const w = () => W * size;
  const h = () => H * size;
  const awake = () => pose !== "sleep";
  const away = () => host.hidden() || document.hidden;
  const quiet = () => {
    if (!opts.quietNight) return false;
    const hr = new Date().getHours();
    return hr >= 23 || hr < 8;
  };

  /* ---------- the element ---------- */

  function build() {
    el = document.createElement("div");
    el.className = "cat";
    el.innerHTML = `<div class="cat-fx"></div><div class="cat-hop"><div class="cat-spin"><div class="cat-flip">${CAT_SVG}</div></div></div><div class="cat-bubble" role="status"></div>`;
    fx = el.querySelector(".cat-fx");
    bubble = el.querySelector(".cat-bubble");
    // Behind the bars, so icons that grow under the pointer stay on top.
    dock.insertBefore(el, bars);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("contextmenu", onMenu);
    el.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    dock.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    let saved = NaN;
    try {
      saved = Number(localStorage.getItem("dd.cat.x"));
    } catch {
      // ignore
    }
    const lanes = getLanes();
    if (Number.isFinite(saved) && saved > 0) x = nearest(saved, lanes);
    else if (lanes.length) x = lanes[Math.floor((lanes.length - 1) / 2)].b;
    place();
    setPose("sit");
  }

  function teardown() {
    if (!el) return;
    trip++;
    anim?.cancel();
    for (const k of Object.keys(timers)) clearTimeout(timers[k]);
    offStats?.();
    offMedia?.();
    offStats = offMedia = null;
    dock.removeEventListener("pointermove", onMove);
    document.removeEventListener("visibilitychange", onVisibility);
    el.remove();
    el = null;
    host.hits();
  }

  function paint() {
    const f = FURS[opts.fur] || FURS.ginger;
    const s = el.style;
    s.setProperty("--cf", f.fur);
    s.setProperty("--cd", f.dark);
    s.setProperty("--cs", f.stripe);
    s.setProperty("--cb", f.belly);
    s.setProperty("--ce", f.eye);
    s.setProperty("--cp", f.pupil);
    el.dataset.fur = opts.fur;
    size = clamp(Number(opts.size) || 1, 0.6, 1.6);
    s.setProperty("--cat-w", `${w()}px`);
    s.setProperty("--cat-h", `${h()}px`);
    el.title = opts.name || "";
  }

  function place() {
    el.style.transform = `translateX(${x}px)`;
    try {
      localStorage.setItem("dd.cat.x", String(Math.round(x)));
    } catch {
      // ignore
    }
  }

  function setPose(p) {
    pose = p;
    el.dataset.pose = p;
    el.classList.remove("is-deep");
    if (p === "sleep") {
      setFace();
      stop("blink");
      later("deep", 45_000, () => el?.classList.add("is-deep"));
      zzz();
    } else {
      stop("deep");
      stop("zzz");
      blinkSoon();
    }
  }

  function face(dir) {
    if (!dir || dir === facing) return;
    facing = dir;
    el.classList.toggle("is-left", facing < 0);
  }

  /** Eyes and mouth: one of "", shut, joy, half; plus extras. */
  function setFace(eyes = "", ...extra) {
    el.classList.remove("is-shut", "is-joy", "is-half", "is-meow", "is-yawn", "is-tongue");
    if (eyes) el.classList.add(`is-${eyes}`);
    for (const e of extra) el.classList.add(`is-${e}`);
  }

  /** Adds a class for `ms`, for one-shot CSS animations. */
  function flash(cls, ms) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
    later(`flash-${cls}`, ms, () => el?.classList.remove(cls));
  }

  function hop(ms) {
    el.style.setProperty("--hop-ms", `${Math.round(ms)}ms`);
    flash("is-hop", ms);
  }

  function spawn(kind, text, count = 1) {
    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      p.className = `cat-p cat-p-${kind}`;
      p.textContent = text;
      p.style.setProperty("--dx", `${rand(-10, 10).toFixed(1)}px`);
      p.style.animationDelay = `${i * 260}ms`;
      p.addEventListener("animationend", () => p.remove());
      fx.append(p);
    }
  }

  /* ---------- where it can walk ---------- */

  /** The tops of the current bar's islands, as ranges of the cat's left edge. */
  function getLanes() {
    const d = dock.getBoundingClientRect();
    const out = [];
    for (const p of bars.querySelectorAll(".bar.is-current .pill")) {
      const r = p.getBoundingClientRect();
      if (r.width < w() + 12) continue;
      out.push({ a: r.left - d.left + 6, b: r.right - d.left - w() - 6 });
    }
    out.sort((p, q) => p.a - q.a);
    if (!out.length) out.push({ a: 6, b: Math.max(6, d.width - w() - 6) });
    return out;
  }

  function nearest(v, lanes = getLanes()) {
    let best = lanes[0].a;
    for (const l of lanes) {
      const c = clamp(v, l.a, l.b);
      if (Math.abs(c - v) < Math.abs(best - v)) best = c;
    }
    return best;
  }

  const laneOf = (v, lanes) => lanes.findIndex((l) => v >= l.a - 1 && v <= l.b + 1);

  function currentX() {
    if (anim && anim.playState === "running") {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return m.m41;
    }
    return x;
  }

  function cancelMove() {
    trip++;
    if (anim) {
      x = currentX();
      anim.cancel();
      anim = null;
      place();
    }
    if (moving) {
      moving = null;
      host.hits();
    }
  }

  /** Moves to `to` in `ms`, as a walk or a hop. Resolves false if cancelled. */
  function slide(to, ms, kind) {
    const from = x;
    face(Math.sign(to - from));
    moving = [Math.min(from, to), Math.max(from, to)];
    host.hits();
    if (kind === "hop") hop(ms);
    anim = el.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
      duration: ms,
      easing: kind === "hop" ? "cubic-bezier(.3,.1,.4,1)" : "linear",
    });
    x = to;
    place();
    return anim.finished.then(
      () => true,
      () => false
    );
  }

  /** Walks to `target`, hopping across the gaps between islands. */
  async function travel(target, { speed = 42 } = {}) {
    cancelMove();
    const my = trip;
    if (host.reduced()) {
      x = nearest(target);
      place();
      return true;
    }
    const lanes = getLanes();
    target = nearest(target, lanes);
    setPose(speed > 80 ? "run" : "walk");
    let i = laneOf(x, lanes);
    if (i < 0) {
      // Not on an island (the bar changed): drop onto the nearest one.
      const to = nearest(x, lanes);
      if (!(await slide(to, 380, "hop")) || my !== trip) return false;
      i = laneOf(x, lanes);
    }
    const j = laneOf(target, lanes);
    while (i !== j && i >= 0) {
      const dir = j > i ? 1 : -1;
      const edge = dir > 0 ? lanes[i].b : lanes[i].a;
      if (Math.abs(edge - x) > 1 && !(await slide(edge, (Math.abs(edge - x) / speed) * 1000, "walk"))) return false;
      if (my !== trip) return false;
      i += dir;
      const land = dir > 0 ? lanes[i].a : lanes[i].b;
      if (!(await slide(land, clamp(Math.abs(land - x) * 6, 320, 620), "hop"))) return false;
      if (my !== trip) return false;
    }
    if (Math.abs(target - x) > 1 && !(await slide(target, (Math.abs(target - x) / speed) * 1000, "walk"))) return false;
    if (my !== trip) return false;
    anim = null;
    moving = null;
    host.hits();
    setPose("sit");
    return true;
  }

  /* ---------- everyday life ---------- */

  function schedule(ms) {
    later("act", ms, act);
  }

  function act() {
    if (!el) return;
    if (busy || held || petting) return schedule(4000);
    if (away()) return schedule(15_000);
    const idle = Date.now() - lastNear;
    const hr = new Date().getHours();
    const night = hr >= 23 || hr < 7;

    if (pose === "sleep") {
      // Naps last a few minutes, unless the night is long.
      if (Date.now() - sleptAt > (night ? 20 : rand(3, 7)) * 60_000 || (lowBattery && !opts.sleep)) wake();
      return schedule(rand(20, 40) * 1000);
    }

    const choices = [];
    const lanes = getLanes();
    const canWalk = opts.roam && !tired && !lowBattery && !host.reduced();
    if (canWalk) choices.push(["walk", 7]);
    choices.push(["look", 3], ["groom", 2], ["yawn", tired ? 4 : 1]);
    if (playing && opts.system) choices.push(["dance", 4]);
    if (opts.sleep && (idle > 90_000 || tired || lowBattery)) choices.push(["sleep", night || lowBattery ? 10 : 3]);
    let total = choices.reduce((n, c) => n + c[1], 0);
    let r = Math.random() * total;
    const [what] = choices.find((c) => (r -= c[1]) < 0) || choices[0];

    if (what === "walk") {
      const lane = pick(lanes);
      let to = rand(lane.a, lane.b);
      if (Math.abs(to - x) < 30) to = rand(lanes[0].a, lanes[lanes.length - 1].b);
      travel(to).then((ok) => ok && schedule(rand(5, 14) * 1000));
      return;
    }
    if (what === "look") {
      if (Math.random() < 0.5) face(-facing);
      flash("is-flick", 1300);
      if (Math.random() < 0.4) flash("is-twitch", 400);
    }
    if (what === "groom") groom();
    if (what === "yawn") yawn();
    if (what === "dance") dance();
    if (what === "sleep") return sleep();
    schedule(rand(5, 13) * 1000);
  }

  function blinkSoon() {
    later("blink", rand(2800, 7000), () => {
      if (!el || !awake()) return;
      if (!away()) flash("is-blink", 160);
      blinkSoon();
    });
  }

  let sleptAt = 0;
  function sleep() {
    cancelMove();
    setPose("sleep");
    sleptAt = Date.now();
    schedule(30_000);
  }

  function wake(grumpy = false) {
    if (pose !== "sleep") return;
    setPose("sit");
    setFace("half");
    later("face", 900, () => el && !petting && !busy && setFace());
    flash("is-twitch", 400);
    if (grumpy && Math.random() < 0.35) say(t("Hm? I was sleeping…"), { cool: 10 * 60_000 });
    schedule(rand(4, 9) * 1000);
  }

  function zzz() {
    const again = () => {
      if (!el || pose !== "sleep") return;
      if (!away()) spawn("z", "z", 3);
      later("zzz", el.classList.contains("is-deep") ? 30_000 : 8000, again);
    };
    later("zzz", 1500, again);
  }

  function play(ms, fn) {
    busy = true;
    fn?.();
    later("busy", ms, endPlay);
  }

  function endPlay() {
    stop("busy");
    busy = false;
    if (!el) return;
    setFace();
    el.classList.remove("is-groom", "is-stretch", "is-dance", "is-eat", "is-crouch");
  }

  function groom() {
    play(2600, () => {
      setFace("shut");
      el.classList.add("is-groom");
    });
  }

  function yawn() {
    play(1800, () => {
      setFace("shut", "yawn");
      el.classList.add("is-stretch");
    });
  }

  function dance() {
    play(6000, () => {
      setFace("joy");
      el.classList.add("is-dance");
      spawn("note", "♪", 2);
      later("note2", 2600, () => spawn("note", "♫", 2));
    });
  }

  /* ---------- talking ---------- */

  /** Shows a bubble. `cool`: don't repeat this line within that many ms. */
  function say(text, { ms = 4200, cool = 0, force = false } = {}) {
    if (!el || (!opts.bubbles && !force)) return false;
    if (cool && Date.now() - (said.get(text) || 0) < cool) return false;
    said.set(text, Date.now());
    bubble.textContent = text;
    // Keep the bubble on the screen.
    const d = dock.getBoundingClientRect();
    bubble.style.setProperty("--bx", "0px");
    bubble.classList.add("is-on");
    const r = bubble.getBoundingClientRect();
    const shift = r.left < 8 ? 8 - r.left : r.right > d.right - 8 ? d.right - 8 - r.right : 0;
    bubble.style.setProperty("--bx", `${shift}px`);
    later("bubble", ms, () => bubble?.classList.remove("is-on"));
    return true;
  }

  function voice(kind) {
    if (!opts.sound) return;
    meow(kind, opts.volume);
    el.classList.add("is-meow");
    later("mouth", kind === "sad" ? 950 : 600, () => el?.classList.remove("is-meow"));
  }

  function chatSoon() {
    if (!opts.bubbles) return stop("chat");
    const [a, b] = minutes(opts.bubbleRate);
    later("chat", rand(a, b), () => {
      if (el && awake() && !away() && !busy) say(t(pick(IDLE_LINES)));
      chatSoon();
    });
  }

  function meowSoon() {
    if (!opts.sound) return stop("meow");
    const [a, b] = minutes(opts.meowRate);
    later("meow", rand(a, b), () => {
      if (el && awake() && !away() && !quiet() && !busy) {
        voice(pick(["meow", "short", "ask"]));
        say(t("Meow!"), { ms: 1800 });
      }
      meowSoon();
    });
  }

  function breakSoon() {
    const mins = Number(opts.breaks) || 0;
    if (!mins) return stop("break");
    later("break", mins * 60_000, () => {
      if (!el) return;
      if (away()) {
        // Busy with a game or a film: ask again a little later.
        later("break", 5 * 60_000, breakSoon);
        return;
      }
      wake();
      yawn();
      say(t("Break time! Let's stretch a little."), { ms: 7000, force: true });
      if (!quiet()) voice("ask");
      breakSoon();
    });
  }

  function greet() {
    const hr = new Date().getHours();
    const line = hr >= 5 && hr < 11 ? "Good morning! ☀️" : hr < 17 && hr >= 11 ? "Hi! Let's get things done." : hr < 23 && hr >= 17 ? "Good evening!" : "It's late… bedtime soon?";
    later("greet", 2600, () => {
      if (!el || away()) return;
      say(t(line));
      if (!quiet()) voice("short");
    });
  }

  /* ---------- the computer ---------- */

  function watchSystem() {
    offStats?.();
    offMedia?.();
    offStats = offMedia = null;
    tired = lowBattery = playing = false;
    if (!opts.system) return;
    let hot = 0;
    offStats = subscribeStats((s) => {
      if (!s || !el) return;
      hot = s.cpu >= 85 ? hot + 1 : 0;
      if (hot >= 2 && !tired) {
        tired = true;
        if (!busy) {
          wake();
          setFace("half", "tongue");
          spawn("sweat", "💧");
          later("face", 5000, () => el && !busy && !petting && setFace(tired ? "half" : ""));
        }
        say(t("The processor is at {n}%. I'm so tired!", { n: Math.round(s.cpu) }), { cool: 15 * 60_000 });
      } else if (s.cpu < 60 && tired) {
        tired = false;
        if (!busy && awake()) setFace();
      }
      if (typeof s.battery === "number") {
        const low = s.battery <= 20 && !s.charging;
        if (low && !lowBattery) {
          if (say(t("Battery at {n}%. Plug me in?", { n: Math.round(s.battery) }), { cool: 20 * 60_000 }) && !quiet()) voice("sad");
        }
        lowBattery = low;
        if (charging === false && s.charging) {
          say(t("Charging! ⚡ That feels good."), { cool: 10 * 60_000 });
          if (!quiet()) voice("happy");
          if (pose === "sleep") wake();
        }
        charging = !!s.charging;
      }
    }, 5000);
    offMedia = mediaSource.subscribe((m) => {
      const now = !!(m?.hasSession && m.playing);
      if (now && !playing && el && awake() && !away()) {
        later("dance", 1200, () => {
          if (!el || busy || held) return;
          dance();
          if (Math.random() < 0.5) say(t("Nice song! 🎵"), { cool: 10 * 60_000 });
        });
      }
      playing = now;
    });
  }

  /* ---------- the pointer ---------- */

  function center() {
    const d = dock.getBoundingClientRect();
    const top = host.top();
    return { x: d.left + currentX() + w() / 2, y: top ? d.bottom + h() / 2 : d.top - h() / 2 };
  }

  function onMove(e) {
    if (!el || !opts.hover || held) return;
    const c = center();
    const dx = e.clientX - c.x;
    const dy = e.clientY - c.y;
    const now = performance.now();
    const speed = Math.abs(e.clientX - lastPointer.x) / Math.max(1, now - lastPointer.t);
    lastPointer = { x: e.clientX, t: now };
    if (Math.abs(dx) > 180) return;
    lastNear = Date.now();
    if (pose === "sleep") {
      later("wake", 700, () => wake(true));
      return;
    }
    if (pose === "walk" || pose === "run") return;
    // Turn to face the pointer, and follow it with the eyes.
    if (!busy && dx * facing < -24) face(Math.sign(dx));
    el.style.setProperty("--lx", `${(clamp(dx / 70, -1, 1) * 1.1 * facing).toFixed(2)}px`);
    el.style.setProperty("--ly", `${(clamp(dy / 60, -1, 1) * 0.8).toFixed(2)}px`);
    el.classList.add("is-alert");
    later("alert", 2200, () => {
      el?.classList.remove("is-alert");
      el?.style.setProperty("--lx", "0px");
      el?.style.setProperty("--ly", "0px");
    });
    // A pointer darting past is prey.
    if (opts.play && !busy && !petting && speed > 1.1 && Math.abs(dx) > 50 && Math.abs(dx) < 170 && Date.now() - pounceAt > 3500) {
      pounce(e.clientX);
    }
  }

  function pounce(clientX) {
    pounceAt = Date.now();
    cancelMove();
    const d = dock.getBoundingClientRect();
    const target = nearest(clientX - d.left - w() / 2);
    face(Math.sign(target - x) || facing);
    busy = true;
    el.classList.add("is-crouch");
    later("pounce", 520, async () => {
      if (!el) return;
      el.classList.remove("is-crouch");
      const lanes = getLanes();
      const i = laneOf(x, lanes);
      const to = i >= 0 ? clamp(target, lanes[i].a, lanes[i].b) : target;
      await slide(to, clamp(Math.abs(to - x) * 4, 260, 520), "hop");
      anim = null;
      moving = null;
      host.hits();
      if (!el) return;
      setPose("sit");
      flash("is-swipe", 420);
      busy = false;
      schedule(rand(4, 8) * 1000);
    });
  }

  function onEnter() {
    if (!opts.hover || held) return;
    lastNear = Date.now();
    const start = () => {
      if (!el || held) return;
      // Let a trick finish first, then the petting starts.
      if (busy && el.classList.contains("is-dance")) endPlay();
      if (busy) return later("pet", 500, start);
      if (pose === "sleep") wake();
      cancelMove();
      setPose("sit");
      petting = Date.now();
      setFace("joy");
      el.classList.add("is-pet");
      if (opts.sound && opts.purr) purr(opts.volume * 0.8, 2.6);
      const hearts = () => {
        if (!petting || !el) return;
        spawn("heart", "♥");
        later("hearts", 900, hearts);
      };
      hearts();
      if (Math.random() < 0.3) say(t("Purrrr ♥"), { ms: 2400, cool: 60_000 });
    };
    later("pet", 550, start);
  }

  function onLeave() {
    stop("pet");
    stop("hearts");
    if (!petting) return;
    petting = 0;
    el?.classList.remove("is-pet");
    if (el && !busy) setFace();
  }

  /* ---------- clicks, tricks, picking up ---------- */

  let down = null;
  function onDown(e) {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", onDrag);
    el.addEventListener("pointerup", onUp, { once: true });
    el.addEventListener("pointercancel", onUp, { once: true });
  }

  function onDrag(e) {
    if (!down) return;
    if (!down.moved) {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 || !opts.play) return;
      down.moved = true;
      pickUp();
    }
    const d = dock.getBoundingClientRect();
    x = clamp(e.clientX - d.left - w() / 2, 0, d.width - w());
    place();
  }

  function onUp() {
    el?.removeEventListener("pointermove", onDrag);
    const was = down;
    down = null;
    if (!el || !was) return;
    if (was.moved) return putDown();
    trick();
  }

  function pickUp() {
    cancelMove();
    stop("pet");
    petting = 0;
    held = true;
    busy = true;
    if (pose === "sleep") setPose("sit");
    el.classList.remove("is-pet");
    el.classList.add("is-held");
    el.dataset.pose = "held";
    setFace("", "meow");
    if (Math.random() < 0.5) say(t("Wheee!"), { ms: 1600 });
    host.hits();
  }

  async function putDown() {
    held = false;
    el.classList.remove("is-held");
    setFace();
    const to = nearest(x);
    await slide(to, clamp(Math.abs(to - x) * 5, 220, 480), "hop");
    anim = null;
    moving = null;
    if (!el) return;
    setPose("sit");
    busy = false;
    host.hits();
    schedule(rand(5, 10) * 1000);
  }

  function trick() {
    if (busy) return;
    lastNear = Date.now();
    if (pose === "sleep") {
      wake(true);
      return;
    }
    cancelMove();
    setPose("sit");
    const tricks = opts.play ? ["meow", "hop", "spin", "roll", "swipe"] : ["meow"];
    const what = pick(tricks);
    if (what === "meow" || !opts.play) {
      voice(pick(["meow", "short", "happy"]));
      say(t(pick(["Meow!", "Mrrp?", "Hi there!", "Meow meow!"])), { ms: 2000 });
      return;
    }
    if (what === "hop") play(600, () => hop(600));
    if (what === "spin") {
      play(1300, () => flash("is-spin", 1300));
      if (Math.random() < 0.5) say(t("Where's my tail?!"), { ms: 2200 });
    }
    if (what === "roll") play(900, () => {
      flash("is-roll", 900);
      setFace("joy");
    });
    if (what === "swipe") play(700, () => flash("is-swipe", 420));
    if (Math.random() < 0.5) voice("short");
  }

  function treat() {
    if (pose === "sleep") wake();
    cancelMove();
    setPose("sit");
    play(2600, () => {
      setFace("joy");
      el.classList.add("is-eat");
      spawn("fish", "🐟");
    });
    say(t("Yum yum! 🐟"), { ms: 2600, force: true });
    if (!quiet()) voice("happy");
  }

  function onMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const name = opts.name || t("Cat");
    host.menu(el, [
      { header: name },
      { label: t("Give a treat"), icon: "heart", action: treat },
      pose === "sleep"
        ? { label: t("Wake up"), icon: "sun", action: () => wake() }
        : { label: t("Go to sleep"), icon: "moon", action: sleep },
      { label: t("Meows"), checked: opts.sound, action: () => host.save({ sound: !opts.sound }) },
      { label: t("Speech bubbles"), checked: opts.bubbles, action: () => host.save({ bubbles: !opts.bubbles }) },
      { label: t("Walks around"), checked: opts.roam, action: () => host.save({ roam: !opts.roam }) },
      "-",
      { label: t("Cat settings…"), icon: "sliders", action: () => host.settings() },
      { label: t("Hide the cat"), icon: "close", action: () => host.save({ enabled: false }) },
    ]);
  }

  function onVisibility() {
    if (document.hidden) cancelMove();
  }

  /* ---------- outside ---------- */

  return {
    /** New settings (the `cat` part of the config). */
    update(next) {
      const was = opts;
      opts = next;
      if (!opts.enabled) {
        teardown();
        return;
      }
      const fresh = !el;
      if (fresh) build();
      paint();
      if (fresh || was?.bubbleRate !== opts.bubbleRate || was?.bubbles !== opts.bubbles) chatSoon();
      if (fresh || was?.meowRate !== opts.meowRate || was?.sound !== opts.sound) meowSoon();
      if (fresh || was?.breaks !== opts.breaks) breakSoon();
      if (fresh || was?.system !== opts.system) watchSystem();
      if (!opts.roam && (pose === "walk" || pose === "run")) {
        cancelMove();
        setPose("sit");
      }
      if (!opts.sleep && pose === "sleep") wake();
      if (fresh) {
        greet();
        schedule(rand(6, 10) * 1000);
      }
      host.hits();
    },
    /** The bar changed or the window resized: get back onto an island. */
    relayout() {
      if (!el || held) return;
      const lanes = getLanes();
      if (laneOf(x, lanes) >= 0) return host.hits();
      if (pose === "walk" || pose === "run") cancelMove();
      const to = nearest(x, lanes);
      if (host.reduced() || Math.abs(to - x) > 400) {
        x = to;
        place();
        host.hits();
      } else {
        slide(to, 380, "hop").then(() => {
          anim = null;
          moving = null;
          if (el && pose !== "sleep") setPose("sit");
          host.hits();
        });
      }
    },
    /** Where the cat takes the pointer, in window pixels. */
    rects() {
      if (!el) return [];
      const d = dock.getBoundingClientRect();
      const span = held ? [0, d.width - w()] : moving || [x, x];
      const top = host.top();
      const room = 18 * size; // for hops
      return [
        {
          x: d.left + span[0] - 4,
          y: top ? d.bottom - 2 : d.top - h() - room,
          width: span[1] - span[0] + w() + 8,
          height: h() + room + 2,
        },
      ];
    },
    toggle() {
      host.save({ enabled: !opts?.enabled });
    },
    destroy: teardown,
  };
}
