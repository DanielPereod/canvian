import { useSyncExternalStore } from 'react';
import { api } from './api';

// Letra de la interfaz, de los títulos y tamaño base. Se aplica como variables
// en la raíz (--type-ui, --type-title, --type-scale) que usa el diseño
// Biblioteca. Se guarda en el servidor, y en este navegador para el primer fotograma.

export type UiFont = 'inter' | 'jost' | 'instrument' | 'archivo' | 'sistema';
export type TitleFont = 'serif' | 'fraunces' | 'sans';
export type Typography = { ui: UiFont; titles: TitleFont; size: number };

export const UI_FONTS: { id: UiFont; name: string; stack: string }[] = [
  { id: 'inter', name: 'Inter', stack: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif" },
  { id: 'sistema', name: 'Del sistema', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: 'instrument', name: 'Instrument Sans', stack: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'archivo', name: 'Archivo', stack: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'jost', name: 'Jost', stack: "'Jost Variable', 'Jost', ui-sans-serif, system-ui, sans-serif" },
];
export const TITLE_FONTS: { id: TitleFont; name: string }[] = [
  { id: 'serif', name: 'Newsreader' },
  { id: 'fraunces', name: 'Fraunces' },
  { id: 'sans', name: 'La de la interfaz' },
];
export const SIZES: { px: number; name: string }[] = [
  { px: 13, name: 'Pequeño' },
  { px: 14, name: 'Estándar' },
  { px: 15, name: 'Cómodo' },
  { px: 16, name: 'Grande' },
];

const DEFAULT: Typography = { ui: 'inter', titles: 'serif', size: 14 };
const LOCAL = 'canvian:type';
let current = DEFAULT;
const listeners = new Set<() => void>();

function clean(v: unknown): Typography | null {
  const t = v as Partial<Typography> | null;
  if (!t || !UI_FONTS.some((f) => f.id === t.ui) || !TITLE_FONTS.some((f) => f.id === t.titles)) return null;
  if (typeof t.size !== 'number' || t.size < 12 || t.size > 18) return null;
  return { ui: t.ui!, titles: t.titles!, size: Math.round(t.size) };
}

function apply(t: Typography) {
  current = t;
  const root = document.documentElement.style;
  const ui = UI_FONTS.find((f) => f.id === t.ui)!.stack;
  root.setProperty('--type-ui', ui);
  root.setProperty(
    '--type-title',
    t.titles === 'serif' ? "'Newsreader Variable', 'Newsreader', Georgia, serif" : t.titles === 'fraunces' ? "'Fraunces Variable', 'Fraunces', Georgia, serif" : ui,
  );
  root.setProperty('--type-scale', String(t.size / 14));
  try {
    localStorage.setItem(LOCAL, JSON.stringify(t));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

export function startTypography() {
  try {
    const raw = localStorage.getItem(LOCAL);
    apply((raw && clean(JSON.parse(raw))) || DEFAULT);
  } catch {
    apply(DEFAULT);
  }
}

export function loadTypography() {
  return api
    .prefs()
    .then((p) => {
      const saved = clean(p.type);
      if (saved) apply(saved);
    })
    .catch(() => {});
}

export function setTypography(change: Partial<Typography>) {
  const before = current;
  const next = { ...current, ...change };
  apply(next);
  return api.savePref('type', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export function useTypography() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
