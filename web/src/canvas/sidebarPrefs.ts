import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Lo que se elige a mano en la barra lateral: el orden de las hijas de cada
// nota (arrastrando) y el color de cada una. Se guarda en el servidor.

export type SidebarPrefs = { order: Record<string, string[]>; colors: Record<string, string> };

export const ROOT_KEY = 'root';
export const COLORS: { hex: string; name: string }[] = [
  { hex: '#8e5bd8', name: 'Violeta' },
  { hex: '#3b82f6', name: 'Azul' },
  { hex: '#14b8a6', name: 'Turquesa' },
  { hex: '#65a30d', name: 'Verde' },
  { hex: '#d4a017', name: 'Mostaza' },
  { hex: '#ea7a2b', name: 'Naranja' },
  { hex: '#e0487a', name: 'Rosa' },
  { hex: '#d13f3f', name: 'Rojo' },
  { hex: '#8b5e3c', name: 'Marrón' },
  { hex: '#6b7280', name: 'Gris' },
];

const LOCAL = 'canvian:sidebar';
let current: SidebarPrefs = { order: {}, colors: {} };
const listeners = new Set<() => void>();

const clean = (v: unknown): SidebarPrefs | null => {
  const p = v as Partial<SidebarPrefs> | null;
  return p && typeof p.order === 'object' && typeof p.colors === 'object' ? { order: p.order ?? {}, colors: p.colors ?? {} } : null;
};

function apply(p: SidebarPrefs) {
  current = p;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(p));
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

export function loadSidebarPrefs() {
  return api
    .prefs()
    .then((p) => {
      const saved = clean(p.sidebar);
      if (saved) apply(saved);
    })
    .catch(() => {});
}

function save(next: SidebarPrefs) {
  const before = current;
  apply(next);
  return api.savePref('sidebar', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export const setOrder = (parent: string | null, ids: string[]) => save({ ...current, order: { ...current.order, [parent ?? ROOT_KEY]: ids } });

export function setColor(id: string, hex: string | null) {
  const colors = { ...current.colors };
  if (hex) colors[id] = hex;
  else delete colors[id];
  return save({ ...current, colors });
}

// Ordena las hijas: primero las que tienen sitio elegido, luego el resto como siempre.
export function sortByOrder<T extends { id: string }>(parent: string | null, list: T[], fallback: (a: T, b: T) => number, prefs = current): T[] {
  const order = prefs.order[parent ?? ROOT_KEY];
  if (!order?.length) return [...list].sort(fallback);
  const at = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ia = at.get(a.id);
    const ib = at.get(b.id);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return fallback(a, b);
  });
}

export function useSidebarPrefs() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
