import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Lo que cada nota recuerda de cómo se ve, guardado en el servidor: si se lee
// en modo ancho (su texto ocupa más de la hoja) y si se abre como colección
// (sus hijas en tabla, lista, galería, tablero o calendario en vez del texto).

const clean = (v: unknown) => (Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : null);

function noteFlag(pref: 'wide' | 'collection') {
  const LOCAL = `canvian:${pref}`;
  let current: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

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

  const load = () =>
    api
      .prefs()
      .then((p) => apply(clean(p[pref]) ?? new Set()))
      .catch(() => {});

  const toggle = (id: string) => {
    const before = current;
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    apply(next);
    const done = next.size ? api.savePref(pref, [...next]) : api.deletePref(pref);
    return done.catch((e) => {
      apply(before);
      throw e;
    });
  };

  const use = (id: string) =>
    useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => current.has(id),
    );

  return { load, toggle, use };
}

const wide = noteFlag('wide');
const collection = noteFlag('collection');

export const loadWide = () => Promise.all([wide.load(), collection.load()]);
export const toggleWide = wide.toggle;
export const useWide = wide.use;
export const toggleAsCollection = collection.toggle;
export const useAsCollection = collection.use;
