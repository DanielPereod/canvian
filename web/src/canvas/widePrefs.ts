import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Las notas que se leen en modo ancho: su texto ocupa más de la hoja. Cada
// nota recuerda el suyo; se guarda en el servidor.

const LOCAL = 'canvian:wide';
let current: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const clean = (v: unknown) => (Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : null);

function apply(next: ReadonlySet<string>) {
  current = next;
  try {
    localStorage.setItem(LOCAL, JSON.stringify([...next]));
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
  // Sin almacenamiento local se empieza en blanco.
}

export function loadWide() {
  return api
    .prefs()
    .then((p) => apply(clean(p.wide) ?? new Set()))
    .catch(() => {});
}

export function toggleWide(id: string) {
  const before = current;
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  apply(next);
  const done = next.size ? api.savePref('wide', [...next]) : api.deletePref('wide');
  return done.catch((e) => {
    apply(before);
    throw e;
  });
}

export function useWide(id: string) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current.has(id),
  );
}
