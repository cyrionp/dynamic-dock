// Every text is written in English in the code; `t()` returns it in the
// chosen language. Missing translations simply stay English.

import { TR } from "./i18n-tr.js";

const LANGS = { tr: TR };
let lang = "en";

export const LANGUAGES = [
  { id: "auto", label: "Same as Windows" },
  { id: "en", label: "English" },
  { id: "tr", label: "Türkçe" },
];

export function setLang(choice) {
  const sys = (navigator.language || "en").slice(0, 2).toLowerCase();
  lang = choice && choice !== "auto" ? choice : sys;
  if (!LANGS[lang]) lang = "en";
  document.documentElement.lang = lang;
}

export const getLang = () => lang;

/** "Version {v}" with { v: "1.0" } → "Version 1.0", translated. */
export function t(text, vars) {
  let out = LANGS[lang]?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

/** The locale for dates and numbers. */
export const locale = () => (lang === "tr" ? "tr-TR" : undefined);
