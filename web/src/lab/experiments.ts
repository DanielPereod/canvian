import { useSyncExternalStore } from 'react';

// Ideas en prueba. Cada una se enciende y apaga desde el laboratorio (tecla E)
// para compararlas; lo que se elija aquí solo vive en este navegador.
export type ExperimentId = 'memoria' | 'linterna' | 'maduran' | 'constelacion' | 'florecen' | 'secciones';

export const EXPERIMENTS: { id: ExperimentId; name: string; hint: string }[] = [
  { id: 'memoria', name: 'Luz como memoria', hint: 'Lo que no tocas se apaga poco a poco' },
  { id: 'linterna', name: 'Filtro linterna', hint: 'F ilumina lo que buscas y deja el resto en sombra' },
  { id: 'maduran', name: 'Tareas que maduran', hint: 'Semilla, brote y flor en vez de casillas' },
  { id: 'constelacion', name: 'Modo constelación', hint: 'Al alejarte, las notas son estrellas' },
  { id: 'florecen', name: 'Notas que florecen', hint: 'Cuantos más enlaces, más grande y más luz' },
  { id: 'secciones', name: 'Mapa de secciones', hint: 'Muy de lejos, las zonas son territorios; acércate para entrar' },
];

export type Experiments = Record<ExperimentId, boolean>;

const KEY = 'canvian.experiments';
const DEFAULTS: Experiments = { memoria: true, linterna: true, maduran: true, constelacion: true, florecen: true, secciones: false };

function load(): Experiments {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let state = load();
const listeners = new Set<() => void>();

export function toggleExperiment(id: ExperimentId) {
  state = { ...state, [id]: !state[id] };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Sin almacenamiento local la elección dura hasta recargar.
  }
  for (const l of listeners) l();
}

export function useExperiments(): Experiments {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
