import { useSyncExternalStore } from 'react';
import { api } from './api';

// Aspecto de la interfaz: un modo (claro, oscuro o automático, que sigue al
// sistema) y un tema para cada tono. Solo cambia colores, letras y celdas del
// mapa. Se guarda en el servidor para todos los dispositivos, y en este
// navegador para pintarlo bien desde el primer fotograma.

export type ThemeId = 'jardin' | 'papel' | 'observatorio' | 'bloques' | 'piedras' | 'plano' | 'minimo' | 'minimo-claro' | 'biblioteca' | 'biblioteca-noche';
export type Tone = 'dark' | 'light';
export type Mode = Tone | 'auto';

export const THEMES: { id: ThemeId; name: string; hint: string; tone: Tone }[] = [
  { id: 'jardin', name: 'Jardín nocturno', hint: 'Noche, luz del color del perfil', tone: 'dark' },
  { id: 'observatorio', name: 'Observatorio', hint: 'Noche profunda, órbitas finas, letra clásica', tone: 'dark' },
  { id: 'plano', name: 'Plano', hint: 'Papel de plano azul con líneas blancas', tone: 'dark' },
  { id: 'minimo', name: 'Mínimo', hint: 'Negro, grises y una letra sans; nada más', tone: 'dark' },
  { id: 'biblioteca-noche', name: 'Biblioteca', hint: 'Gris carbón y lectura en serif; letra a elegir', tone: 'dark' },
  { id: 'papel', name: 'Papel', hint: 'Tinta sobre papel, como un cuaderno', tone: 'light' },
  { id: 'bloques', name: 'Bloques', hint: 'Brutalista: hueso, negro y amarillo', tone: 'light' },
  { id: 'piedras', name: 'Piedras de río', hint: 'Arena cálida y piedras de colores suaves', tone: 'light' },
  { id: 'minimo-claro', name: 'Mínimo claro', hint: 'Blanco, grises y una letra sans', tone: 'light' },
  { id: 'biblioteca', name: 'Biblioteca', hint: 'Blanco y lectura en serif; letra a elegir', tone: 'light' },
];

export const MODES: { id: Mode; name: string }[] = [
  { id: 'light', name: 'Claro' },
  { id: 'dark', name: 'Oscuro' },
  { id: 'auto', name: 'Automático' },
];

export type Appearance = { mode: Mode; dark: ThemeId; light: ThemeId };

const LOCAL = 'canvian:appearance';
const LEGACY = 'canvian:theme';
// Sin nada guardado (instalación nueva, otro navegador, la app del móvil la
// primera vez): Mínimo, claro u oscuro según el sistema.
const DEFAULT: Appearance = { mode: 'auto', dark: 'minimo', light: 'minimo-claro' };
const toneOf = (id: ThemeId) => THEMES.find((t) => t.id === id)!.tone;
const isTheme = (v: unknown, tone?: Tone): v is ThemeId => THEMES.some((t) => t.id === v && (!tone || t.tone === tone));
const isMode = (v: unknown): v is Mode => MODES.some((m) => m.id === v);

// Del tema de antes (uno solo) al aspecto: su tono pasa a ser el modo.
function fromLegacy(theme: unknown): Appearance {
  if (!isTheme(theme)) return DEFAULT;
  const pair: ThemeId = theme === 'minimo' ? 'minimo-claro' : theme === 'minimo-claro' ? 'minimo' : toneOf(theme) === 'dark' ? 'papel' : 'jardin';
  return toneOf(theme) === 'dark' ? { mode: 'dark', dark: theme, light: pair } : { mode: 'light', dark: pair, light: theme };
}

function clean(v: unknown): Appearance | null {
  const a = v as Partial<Appearance> | null;
  if (!a || !isMode(a.mode) || !isTheme(a.dark, 'dark') || !isTheme(a.light, 'light')) return null;
  return { mode: a.mode, dark: a.dark, light: a.light };
}

const system = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current: Appearance = DEFAULT;
let active = 'jardin' as ThemeId;
let snapshot: Appearance & { active: ThemeId } = { ...current, active };
const listeners = new Set<() => void>();

const resolve = (a: Appearance): ThemeId => {
  const tone: Tone = a.mode === 'auto' ? (system?.matches === false ? 'light' : 'dark') : a.mode;
  return tone === 'dark' ? a.dark : a.light;
};

function paint() {
  active = resolve(current);
  if (active === 'jardin') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = active;
  snapshot = { ...current, active };
  listeners.forEach((l) => l());
}

function apply(a: Appearance) {
  current = a;
  paint();
  try {
    localStorage.setItem(LOCAL, JSON.stringify(a));
  } catch {
    // Sin almacenamiento local, el aspecto llega igual desde el servidor.
  }
}

// En automático, seguir al sistema cuando cambia (p. ej. al anochecer).
system?.addEventListener?.('change', () => current.mode === 'auto' && paint());

// Antes de pintar: lo último usado en este navegador.
export function startTheme() {
  let saved: Appearance | null = null;
  try {
    const raw = localStorage.getItem(LOCAL);
    saved = raw ? clean(JSON.parse(raw)) : null;
    if (!saved && localStorage.getItem(LEGACY)) saved = fromLegacy(localStorage.getItem(LEGACY));
  } catch {
    saved = null;
  }
  if (saved) apply(saved);
  else paint();
}

// Tras entrar: lo que diga el servidor (o el tema de antes, si aún no hay aspecto).
export function loadTheme() {
  return api
    .prefs()
    .then((p) => {
      const saved = clean(p.appearance);
      if (saved) apply(saved);
      else if (p.theme) apply(fromLegacy(p.theme));
    })
    .catch(() => {});
}

function save(next: Appearance) {
  const before = current;
  apply(next);
  return api.savePref('appearance', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export const setMode = (mode: Mode) => save({ ...current, mode });

// Elegir un tema lo pone para su tono; si el modo es fijo, pasa a ese tono para verlo.
export function setTheme(id: ThemeId) {
  const tone = toneOf(id);
  return save({ ...current, [tone]: id, mode: current.mode === 'auto' ? 'auto' : tone });
}

// Un par de temas a la vez (el diseño Biblioteca trae los suyos).
export const setThemes = (dark: ThemeId, light: ThemeId) => save({ ...current, dark, light });

// Claro ↔ oscuro según lo que se ve ahora (sale de automático).
export const toggleMode = () => setMode(toneOf(active) === 'dark' ? 'light' : 'dark');

export function useAppearance() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export const useTheme = () => useAppearance().active;
