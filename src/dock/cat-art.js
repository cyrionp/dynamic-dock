// The dock cat's drawing: one small inline SVG, facing right. Every pose is
// the same parts moved by CSS (cat.css), so changing pose costs nothing but
// a class. Colours come from CSS variables, one set per fur.

export const FURS = {
  ginger: { fur: "#f2a65a", dark: "#d98840", stripe: "#c7712f", belly: "#fff3e3", eye: "#3a2f22", pupil: "#14100b" },
  grey: { fur: "#aab0bb", dark: "#8e94a0", stripe: "#747a87", belly: "#f1f3f6", eye: "#2f3e2f", pupil: "#0f140f" },
  black: { fur: "#3a3a45", dark: "#2b2b34", stripe: "#30303a", belly: "#575763", eye: "#f0cd45", pupil: "#141418" },
  white: { fur: "#f8f5f0", dark: "#e2ddd4", stripe: "#e8e2d8", belly: "#ffffff", eye: "#3b6fb0", pupil: "#10213a" },
  brown: { fur: "#8d6141", dark: "#70482c", stripe: "#5a3820", belly: "#ecd8c5", eye: "#3b6b2a", pupil: "#0f1a0a" },
};

const leg = (cls, x) =>
  `<g class="c-leg ${cls}"><rect x="${x}" y="35.5" width="4.8" height="11" rx="2.4" class="c-limb"/><ellipse cx="${x + 2.4}" cy="45.6" rx="2.6" ry="1.35" class="c-sock"/></g>`;

const eye = (x) =>
  `<g class="c-eye"><ellipse cx="${x}" cy="17.6" rx="2.35" ry="2.9" class="c-iris"/><g class="c-look"><ellipse cx="${x}" cy="17.8" rx="1.25" ry="2.2" class="c-pupil"/><circle cx="${x + 0.8}" cy="16.5" r="0.85" class="c-shine"/></g></g>`;

export const CAT_SVG = `<svg class="cat-svg" viewBox="0 0 64 48" aria-hidden="true">
  <g class="c-awake">
    <g class="c-tail"><path d="M18 34 C 8 34 5 26 8.5 17" class="c-tail-ol"/><path d="M18 34 C 8 34 5 26 8.5 17" class="c-tail-fill"/></g>
    <g class="c-back">${leg("c-bf", 22.5)}</g>
    ${leg("c-ff", 40.5)}
    <g class="c-torso">
      <ellipse cx="30" cy="34.5" rx="14" ry="8.5" class="c-fur"/>
      <ellipse cx="33" cy="38.6" rx="8" ry="3.7" class="c-belly"/>
      <path d="M24 26.9q1.2 2.6 0 5.2M28.5 26.2q1.2 2.8 0 5.6M33 26.4q1.1 2.6 0 5.2" class="c-stripe"/>
    </g>
    <g class="c-haunch"><ellipse cx="22" cy="39" rx="7.6" ry="7.4" class="c-fur"/><path d="M18 34.5q2.5-1.5 5 .3" class="c-stripe"/><ellipse cx="26.5" cy="45.7" rx="3.6" ry="1.45" class="c-sock"/></g>
    <g class="c-back">${leg("c-bn", 17.5)}</g>
    <g class="c-paw">${leg("c-fn", 36)}</g>
    <g class="c-head">
      <path d="M35.5 14 36.5 3.5 43.5 10.5Z" class="c-fur c-ear c-ear-l"/>
      <path d="M45 10.5 52 3.5 53 14Z" class="c-fur c-ear c-ear-r"/>
      <path d="M37.4 11.6 37.9 6.6 41.3 10.2Z M47.2 10.2 50.6 6.6 51.1 11.6Z" class="c-inner"/>
      <ellipse cx="44.3" cy="18.5" rx="11.8" ry="10" class="c-fur"/>
      <path d="M41.2 9.3v3.2M44.3 8.7v3.6M47.4 9.3v3.2" class="c-stripe"/>
      <ellipse cx="44.3" cy="23" rx="5.2" ry="3.6" class="c-belly"/>
      <ellipse cx="36.4" cy="22.3" rx="2" ry="1.2" class="c-blush"/><ellipse cx="52.2" cy="22.3" rx="2" ry="1.2" class="c-blush"/>
      <g class="c-eyes">${eye(39.6)}${eye(49)}</g>
      <path d="M37.3 18.2q2.3 1.8 4.6 0M46.7 18.2q2.3 1.8 4.6 0" class="c-ink c-shut"/>
      <path d="M37.3 18.9q2.3-2.6 4.6 0M46.7 18.9q2.3-2.6 4.6 0" class="c-ink c-joy"/>
      <path d="M42.9 21h2.8l-1.4 1.5z" class="c-nose"/>
      <path d="M44.3 22.5q-.7 1.5-2.2.9M44.3 22.5q.7 1.5 2.2.9" class="c-ink c-smile"/>
      <ellipse cx="44.3" cy="24.6" rx="1.8" ry="2" class="c-mouth"/>
      <path d="M43.4 25.4h1.8v1.6a.9.9 0 0 1-1.8 0z" class="c-tongue"/>
      <path d="M34 21.4l-4.6-.9M34 23.2l-4.7.5M54.6 21.4l4.6-.9M54.6 23.2l4.7.5" class="c-whisker"/>
    </g>
  </g>
  <g class="c-curl">
    <g class="c-breathe">
      <ellipse cx="28.5" cy="39.2" rx="16" ry="7.8" class="c-fur"/>
      <path d="M20 32q1 2.3 0 4.6M24.5 31.5q1 2.5 0 5M29 31.6q1 2.3 0 4.6" class="c-stripe"/>
    </g>
    <path d="M35.4 33.2 36.4 25.6 41.6 30.8Z" class="c-fur"/><path d="M44.4 30.6 49.6 25.8 50.6 33.4Z" class="c-fur"/>
    <path d="M37.1 31.6 37.6 28 40.2 30.5Z M46 30.4 48.9 28 49.3 31.6Z" class="c-inner"/>
    <ellipse cx="43" cy="37.6" rx="9.6" ry="7.9" class="c-fur"/>
    <path d="M40.4 30.4v2.4M43 29.9v2.7M45.6 30.4v2.4" class="c-stripe"/>
    <ellipse cx="43.2" cy="41.2" rx="4.2" ry="2.7" class="c-belly"/>
    <path d="M37.6 37.6q1.9 1.4 3.8 0M44.8 37.6q1.9 1.4 3.8 0" class="c-ink"/>
    <path d="M42 39.6h2.4l-1.2 1.2z" class="c-nose"/>
    <ellipse cx="36.8" cy="40.4" rx="1.7" ry="1" class="c-blush"/><ellipse cx="49.6" cy="40.4" rx="1.7" ry="1" class="c-blush"/>
    <path d="M15 40C14 46.2 38 47 52 43" class="c-tail-ol"/><path d="M15 40C14 46.2 38 47 52 43" class="c-tail-fill"/>
  </g>
</svg>`;
