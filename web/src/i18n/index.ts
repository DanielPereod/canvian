import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { EN } from './en';

// Idiomas de la interfaz. Los textos se escriben en español en el código y
// `t()` los cambia por su traducción; lo que no tenga traducción sale en
// español. El idioma se guarda en el servidor (igual en todos los
// dispositivos) y en este navegador, para pintar bien desde el primer momento
// y en la pantalla de entrada. Sin elegir, manda el idioma del navegador.

export type Lang = 'es' | 'en';

export const LANGS: { id: Lang; name: string }[] = [
  { id: 'es', name: 'Español' },
  { id: 'en', name: 'English' },
];

const LOCAL = 'canvian:lang';
const isLang = (v: unknown): v is Lang => v === 'es' || v === 'en';

function fromBrowser(): Lang {
  const list = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of list) {
    const base = l?.slice(0, 2).toLowerCase();
    if (isLang(base)) return base;
  }
  return 'es';
}

let lang: Lang = 'es';
const listeners = new Set<() => void>();

function apply(next: Lang) {
  lang = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try {
    localStorage.setItem(LOCAL, next);
  } catch {
    // Sin almacenamiento local, el idioma llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

// Antes de pintar: lo último usado aquí, o el del navegador.
export function startLang() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LOCAL);
  } catch {
    saved = null;
  }
  lang = isLang(saved) ? saved : fromBrowser();
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

// Tras entrar: lo que diga el servidor, si se eligió alguno.
export function loadLang() {
  return api
    .prefs()
    .then((p) => {
      if (isLang(p.lang) && p.lang !== lang) apply(p.lang);
    })
    .catch(() => {});
}

export function setLang(next: Lang) {
  const before = lang;
  apply(next);
  return api.savePref('lang', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export const getLang = () => lang;

// Para `Intl` y `localeCompare`.
export const locale = () => (lang === 'en' ? 'en-GB' : 'es-ES');

export function useLang() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => lang,
  );
}

// t('Hola, {nombre}', { nombre }) → «Hello, Ana» en inglés.
export function t(es: string, vars?: Record<string, string | number>): string {
  const text = lang === 'es' ? es : (EN[es] ?? es);
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

// Singular o plural según n: tn(n, '{n} nota', '{n} notas').
export const tn = (n: number, one: string, many: string, vars?: Record<string, string | number>) => t(n === 1 ? one : many, { n, ...vars });
