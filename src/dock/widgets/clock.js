// Clock with a calendar, and the weather (Open-Meteo: free, no key).

import { icon } from "../../lib/icons.js";
import { t, locale } from "../../lib/i18n.js";
import { escapeHtml } from "../../lib/util.js";
import { load, save } from "../../lib/store.js";

const pad = (n) => String(n).padStart(2, "0");

function timeText(d, o) {
  let h = d.getHours();
  let suffix = "";
  if (!o.hour24) {
    suffix = h < 12 ? " AM" : " PM";
    h = h % 12 || 12;
  }
  return `${o.hour24 ? pad(h) : h}:${pad(d.getMinutes())}${o.seconds ? `:${pad(d.getSeconds())}` : ""}${suffix}`;
}

function dateText(d, kind) {
  const loc = locale();
  switch (kind) {
    case "short":
      return d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" });
    case "weekday":
      return d.toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" });
    case "long":
      return d.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" });
    default:
      return "";
  }
}

/** ISO week number. */
function weekOf(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y) / 86400000 + 1) / 7);
}

function calendarHtml(month, opts) {
  const loc = locale();
  const today = new Date();
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // Weeks start on Monday.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(1 - offset);
  const names = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 1 + i); // a Monday
    names.push(d.toLocaleDateString(loc, { weekday: "short" }).slice(0, 2));
  }
  let rows = "";
  const cur = new Date(start);
  for (let w = 0; w < 6; w++) {
    rows += `<tr>${opts.weekNumbers ? `<td class="cal-wk">${weekOf(cur)}</td>` : ""}`;
    for (let i = 0; i < 7; i++) {
      const isToday = cur.toDateString() === today.toDateString();
      const other = cur.getMonth() !== month.getMonth();
      rows += `<td class="${isToday ? "is-today" : ""} ${other ? "is-other" : ""} ${i >= 5 ? "is-weekend" : ""}"><span>${cur.getDate()}</span></td>`;
      cur.setDate(cur.getDate() + 1);
    }
    rows += "</tr>";
  }
  const title = month.toLocaleDateString(loc, { month: "long", year: "numeric" });
  return `<div class="cal-head">
      <button class="icon-btn" data-nav="-1" aria-label="${t("Previous month")}">${icon("left")}</button>
      <button class="cal-title" data-nav="0">${escapeHtml(title)}</button>
      <button class="icon-btn" data-nav="1" aria-label="${t("Next month")}">${icon("right")}</button>
    </div>
    <table class="cal"><thead><tr>${opts.weekNumbers ? "<th></th>" : ""}${names.map((n) => `<th>${escapeHtml(n)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

export const clock = {
  render(el, item, ctx) {
    const o = item.opts;
    el.innerHTML = `<button class="clock ${o.stacked ? "is-stacked" : ""}"><span class="clock-time"></span><span class="clock-date"></span></button>`;
    const b = el.firstChild;
    const timeEl = b.querySelector(".clock-time");
    const dateEl = b.querySelector(".clock-date");
    let timer = 0;
    const tick = () => {
      const d = new Date();
      const tt = timeText(d, o);
      if (timeEl.textContent !== tt) timeEl.textContent = tt;
      const dt = dateText(d, o.date);
      if (dateEl.textContent !== dt) {
        dateEl.textContent = dt;
        dateEl.hidden = !dt;
        ctx.layoutChanged();
      }
      // Wake exactly at the next second (or minute) boundary, no sooner.
      const ms = o.seconds ? 1000 - d.getMilliseconds() : 60000 - d.getSeconds() * 1000 - d.getMilliseconds();
      timer = setTimeout(tick, ms + 5);
    };
    tick();

    b.addEventListener("click", () => {
      let month = new Date();
      ctx.openPopup(b, {
        width: 300,
        className: "calendar",
        build(body) {
          let t2 = 0;
          const head = () => {
            const d = new Date();
            return `<div class="cal-now"><div class="cal-now-time">${timeText(d, { ...o, seconds: true })}</div><div class="cal-now-date">${escapeHtml(dateText(d, "long"))}</div></div>`;
          };
          const paint = () => (body.innerHTML = head() + calendarHtml(month, o));
          paint();
          const live = () => {
            const n = body.querySelector(".cal-now");
            if (n) n.outerHTML = head();
            t2 = setTimeout(live, 1000 - (Date.now() % 1000));
          };
          live();
          body.addEventListener("click", (e) => {
            const nav = e.target.closest("[data-nav]");
            if (!nav) return;
            const step = Number(nav.dataset.nav);
            month = step === 0 ? new Date() : new Date(month.getFullYear(), month.getMonth() + step, 1);
            paint();
          });
          return () => clearTimeout(t2);
        },
      });
    });
    return { destroy: () => clearTimeout(timer) };
  },
};

/* ---------- weather ---------- */

// WMO weather codes → icon and words.
const WMO = [
  [[0], "☀️", "Clear"],
  [[1], "🌤️", "Mostly clear"],
  [[2], "⛅", "Partly cloudy"],
  [[3], "☁️", "Overcast"],
  [[45, 48], "🌫️", "Fog"],
  [[51, 53, 55, 56, 57], "🌦️", "Drizzle"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "🌧️", "Rain"],
  [[71, 73, 75, 77, 85, 86], "🌨️", "Snow"],
  [[95, 96, 99], "⛈️", "Thunderstorm"],
];
const wmo = (code) => WMO.find(([codes]) => codes.includes(code)) ?? [[], "🌡️", "Weather"];

const REFRESH_MS = 30 * 60_000;

async function fetchWeather(city, unit) {
  const key = `weather:${city.toLowerCase()}:${unit}`;
  const cached = load(key, null);
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached;
  const lang = locale() ? "tr" : "en";
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=${lang}&name=${encodeURIComponent(city)}`).then((r) => r.json());
  const place = geo?.results?.[0];
  if (!place) throw new Error(t("City not found"));
  const q = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    forecast_days: "4",
    temperature_unit: unit === "f" ? "fahrenheit" : "celsius",
  });
  const data = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`).then((r) => r.json());
  const out = { at: Date.now(), place: place.name, country: place.country, current: data.current, daily: data.daily };
  save(key, out);
  return out;
}

export const weather = {
  render(el, item, ctx) {
    const o = item.opts;
    el.innerHTML = `<button class="weather"><span class="w-ic"></span><span class="w-temp"></span><span class="w-text"></span></button>`;
    const b = el.firstChild;
    let data = null;
    let error = null;
    let timer = 0;
    const paint = () => {
      const ic = b.querySelector(".w-ic");
      const temp = b.querySelector(".w-temp");
      const text = b.querySelector(".w-text");
      if (!o.city) {
        ic.innerHTML = icon("weather");
        temp.textContent = "";
        text.textContent = "";
      } else if (data) {
        const [, emoji, words] = wmo(data.current.weather_code);
        ic.textContent = emoji;
        temp.textContent = `${Math.round(data.current.temperature_2m)}°`;
        text.textContent = o.showText ? t(words) : "";
      } else {
        ic.innerHTML = icon("weather");
        temp.textContent = error ? "!" : "…";
      }
      ctx.layoutChanged();
    };
    const refresh = async () => {
      clearTimeout(timer);
      if (o.city) {
        try {
          data = await fetchWeather(o.city, o.unit);
          error = null;
        } catch (e) {
          error = String(e.message || e);
        }
      }
      paint();
      timer = setTimeout(refresh, error ? 5 * 60_000 : REFRESH_MS);
    };
    paint();
    refresh();

    b.addEventListener("click", () => {
      ctx.openPopup(b, {
        width: 320,
        className: "weather-pop",
        focus: !o.city,
        build(body, close) {
          if (!o.city || !data) {
            body.innerHTML = `<div class="pop-title">${t("Weather")}</div>
              ${error ? `<p class="hint is-error">${escapeHtml(error)}</p>` : ""}
              <form class="row-form"><input class="input" name="city" placeholder="${t("Your city")}" value="${escapeHtml(o.city)}" /><button class="btn-primary">${t("Save")}</button></form>`;
            const form = body.querySelector("form");
            setTimeout(() => form.city.focus(), 60);
            form.addEventListener("submit", (e) => {
              e.preventDefault();
              const city = form.city.value.trim();
              close();
              ctx.saveItemOpts({ city });
            });
            return;
          }
          const c = data.current;
          const [, emoji, words] = wmo(c.weather_code);
          const days = data.daily.time
            .slice(1)
            .map((d, i) => {
              const day = new Date(d).toLocaleDateString(locale(), { weekday: "short" });
              const [, e] = wmo(data.daily.weather_code[i + 1]);
              return `<div class="w-day"><span>${escapeHtml(day)}</span><span class="w-day-ic">${e}</span><span>${Math.round(data.daily.temperature_2m_max[i + 1])}° <em>${Math.round(data.daily.temperature_2m_min[i + 1])}°</em></span></div>`;
            })
            .join("");
          body.innerHTML = `<div class="w-now">
              <div class="w-big">${emoji}</div>
              <div><div class="w-deg">${Math.round(c.temperature_2m)}°${o.unit === "f" ? "F" : "C"}</div>
              <div class="w-words">${t(words)} · ${escapeHtml(data.place)}</div></div>
            </div>
            <div class="w-facts">
              <span>${t("Feels like")} <b>${Math.round(c.apparent_temperature)}°</b></span>
              <span>${t("Humidity")} <b>${c.relative_humidity_2m}%</b></span>
              <span>${t("Wind")} <b>${Math.round(c.wind_speed_10m)} km/h</b></span>
            </div>
            <div class="w-days">${days}</div>
            <p class="hint">${t("Weather data by Open-Meteo.com")}</p>`;
        },
      });
    });
    return { destroy: () => clearTimeout(timer) };
  },
};
