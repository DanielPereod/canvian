import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

// Cuántos enlaces tiene cada nota. Se calcula una vez al cambiar los enlaces y
// cada nota solo se repinta si cambia el suyo (antes cada nota recorría todos
// los enlaces en cada fotograma al mover el lienzo).
export function createDegreeStore() {
  let degrees = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    set(edges: { source: string; target: string }[]) {
      const next = new Map<string, number>();
      for (const e of edges) {
        next.set(e.source, (next.get(e.source) ?? 0) + 1);
        next.set(e.target, (next.get(e.target) ?? 0) + 1);
      }
      degrees = next;
      listeners.forEach((l) => l());
    },
    get: (id: string) => degrees.get(id) ?? 0,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type DegreeStore = ReturnType<typeof createDegreeStore>;
export const DegreeContext = createContext<DegreeStore | null>(null);

export function useDegree(id: string) {
  const store = useContext(DegreeContext)!;
  const get = useCallback(() => store.get(id), [store, id]);
  return useSyncExternalStore(store.subscribe, get);
}
