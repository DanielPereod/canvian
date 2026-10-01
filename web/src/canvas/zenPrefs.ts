import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Cómo es el modo zen: si además pone el navegador a pantalla completa. Se
// guarda en el servidor (igual en todos los dispositivos) y en este navegador.

type ZenPrefs = { fullscreen: boolean };

const LOCAL = 'canvian:zen';
const DEFAULTS: ZenPrefs = { fullscreen: false };
let current: ZenPrefs = DEFAULTS;
const listeners = new Set<() => void>();

const clean = (v: unknown): ZenPrefs | null =>
  v && typeof v === 'object' && typeof (v as ZenPrefs).fullscreen === 'boolean' ? { fullscreen: (v as ZenPrefs).fullscreen } : null;

function apply(next: ZenPrefs) {
  current = next;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(next));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

try {
  const saved = clean(JSON.parse(localStorage.getItem(LOCAL) ?? 'null'));
  if (saved) current = saved;
} catch {
  // Sin almacenamiento local, los de fábrica.
}

export function loadZenPrefs() {
  return api
    .prefs()
    .then((p) => apply(clean(p.zen) ?? DEFAULTS))
    .catch(() => {});
}

export function setZenFullscreen(fullscreen: boolean) {
  const before = current;
  const next = { ...current, fullscreen };
  apply(next);
  return api.savePref('zen', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export const zenPrefs = () => current;

export function useZenPrefs() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
