// The cat's voice, made on the spot with Web Audio: no sound files to ship
// or load. A meow is a buzzy tone whose pitch rises and falls, shaped by two
// moving vowel filters ("mi-aa-ow"); a purr is a low rumble that swells with
// each breath. The audio context is closed again after every sound, so a
// quiet cat keeps no audio thread running.

let ctx = null;
let closeTimer = 0;
let active = 0;

function open() {
  clearTimeout(closeTimer);
  try {
    if (!ctx || ctx.state === "closed") ctx = new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Closes the context a little after the last sound ends. */
function release(afterMs) {
  active++;
  setTimeout(() => {
    active--;
    if (active > 0) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (active === 0 && ctx) {
        ctx.close().catch(() => {});
        ctx = null;
      }
    }, 400);
  }, afterMs);
}

// Pitch (Hz) and the two vowel filters over the sound's length (0..1).
const KINDS = {
  meow: { len: 0.75, pitch: [[0, 0.9], [0.25, 1.25], [0.7, 1.05], [1, 0.75]], f1: [[0, 500], [0.3, 1000], [0.75, 850], [1, 550]], f2: [[0, 1700], [0.3, 2500], [0.75, 1500], [1, 1000]] },
  short: { len: 0.32, pitch: [[0, 1], [0.5, 1.3], [1, 1.15]], f1: [[0, 600], [0.5, 1000], [1, 900]], f2: [[0, 1900], [0.5, 2600], [1, 2200]] },
  ask: { len: 0.55, pitch: [[0, 0.95], [0.5, 1.05], [1, 1.45]], f1: [[0, 550], [0.6, 950], [1, 1050]], f2: [[0, 1800], [0.6, 2400], [1, 2700]] },
  sad: { len: 0.95, pitch: [[0, 1.1], [0.3, 1.15], [1, 0.7]], f1: [[0, 700], [0.4, 900], [1, 500]], f2: [[0, 2200], [0.4, 2000], [1, 900]] },
  happy: { len: 0.45, pitch: [[0, 1.15], [0.35, 1.45], [1, 1.2]], f1: [[0, 700], [0.4, 1100], [1, 900]], f2: [[0, 2200], [0.4, 2800], [1, 2300]] },
};

function curve(param, points, start, len, scale = 1) {
  param.setValueAtTime(points[0][1] * scale, start);
  for (const [at, v] of points.slice(1)) param.linearRampToValueAtTime(v * scale, start + at * len);
}

/** One meow. `kind`: meow, short, ask, sad or happy. `volume`: 0..1. */
export function meow(kind = "meow", volume = 0.5) {
  const ac = open();
  if (!ac || volume <= 0) return;
  try {
    const k = KINDS[kind] || KINDS.meow;
    const base = 520 * (0.9 + Math.random() * 0.2);
    const len = k.len * (0.9 + Math.random() * 0.2);
    const t = ac.currentTime + 0.02;

    const src = ac.createOscillator();
    src.type = "sawtooth";
    curve(src.frequency, k.pitch, t, len, base);
    // A little vibrato, as a real voice has.
    const vib = ac.createOscillator();
    const vibAmt = ac.createGain();
    vib.frequency.value = 6;
    vibAmt.gain.value = base * 0.015;
    vib.connect(vibAmt).connect(src.frequency);

    const out = ac.createGain();
    const peak = 0.5 * volume;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.08, len * 0.2));
    out.gain.setValueAtTime(peak, t + len * 0.7);
    out.gain.exponentialRampToValueAtTime(0.0001, t + len);

    // The mouth closed at the start ("m") is a soft low-pass.
    const lips = ac.createBiquadFilter();
    lips.type = "lowpass";
    lips.frequency.setValueAtTime(700, t);
    lips.frequency.linearRampToValueAtTime(6000, t + len * 0.2);
    lips.frequency.linearRampToValueAtTime(1800, t + len);

    for (const [points, q, gain] of [[k.f1, 6, 1], [k.f2, 9, 0.55]]) {
      const f = ac.createBiquadFilter();
      f.type = "bandpass";
      f.Q.value = q;
      curve(f.frequency, points, t, len);
      const g = ac.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(lips);
    }
    lips.connect(out).connect(ac.destination);
    src.start(t);
    vib.start(t);
    src.stop(t + len + 0.05);
    vib.stop(t + len + 0.05);
    release((len + 0.2) * 1000);
  } catch {
    // no sound, no problem
  }
}

/** A purr of `seconds`, swelling with each breath. */
export function purr(volume = 0.5, seconds = 2.4) {
  const ac = open();
  if (!ac || volume <= 0) return;
  try {
    const t = ac.currentTime + 0.02;
    // Rumble: a very low buzz, filtered to a soft growl.
    const src = ac.createOscillator();
    src.type = "sawtooth";
    src.frequency.value = 24 + Math.random() * 4;
    const low = ac.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 380;
    low.Q.value = 1.5;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    // Breathing in and out, about one breath a second.
    const breaths = Math.max(1, Math.round(seconds / 1.1));
    const step = seconds / breaths;
    for (let i = 0; i < breaths; i++) {
      const s = t + i * step;
      out.gain.exponentialRampToValueAtTime(0.55 * volume, s + step * 0.45);
      out.gain.exponentialRampToValueAtTime(0.12 * volume, s + step * 0.6);
      out.gain.exponentialRampToValueAtTime(0.4 * volume, s + step * 0.85);
    }
    out.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(low).connect(out).connect(ac.destination);
    src.start(t);
    src.stop(t + seconds + 0.05);
    release((seconds + 0.2) * 1000);
  } catch {
    // no sound, no problem
  }
}
