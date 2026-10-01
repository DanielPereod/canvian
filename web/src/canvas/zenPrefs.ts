import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Modo zen: si además pone la pantalla completa. Se guarda en el servidor.

const LOCAL = 'canvian:zen';
type Zen = { fullscreen: boolean };
let current: Zen = { fullscreen: false };
const listeners = new Set<() => void>();

const clean = (v: unknown): Zen | null => (v && typeof (v as Zen).fullscreen === 'boolean' ? { fullscreen: (v as Zen).fullscreen } : null);

function apply(next: Zen) {
  current = next;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(next));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

try {
  const raw = localStorage.getItem(LOCAL);
  const saved = raw ? clean(JSON.parse(raw)) : null;
  if (saved) current = saved;
} catch {
  // Sin almacenamiento local se empieza con lo de fábrica.
}

export function loadZen() {
  return api
    .prefs()
    .then((p) => apply(clean(p.zen) ?? { fullscreen: false }))
    .catch(() => {});
}

export function setZenFullscreen(fullscreen: boolean) {
  const before = current;
  apply({ ...current, fullscreen });
  return api.savePref('zen', current).catch((e) => {
    apply(before);
    throw e;
  });
}

export const zenFullscreen = () => current.fullscreen;

export function useZenFullscreen() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current.fullscreen,
  );
}
