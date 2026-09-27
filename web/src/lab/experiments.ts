import { useSyncExternalStore } from 'react';

// Ideas en prueba. Cada una se enciende y apaga desde el laboratorio (tecla E)
// para compararlas; lo que se elija aquí solo vive en este navegador.
export type ExperimentId = 'memoria' | 'maduran' | 'foco';

export const EXPERIMENTS: { id: ExperimentId; name: string; hint: string }[] = [
  { id: 'memoria', name: 'Luz como memoria', hint: 'Lo que no tocas se apaga poco a poco' },
  { id: 'maduran', name: 'Tareas que maduran', hint: 'Semilla, brote y flor en vez de casillas' },
  { id: 'foco', name: 'Foco', hint: 'La portada es una lista que se funde; escribe y encuentra. Esc lleva al mapa' },
];

export type Experiments = Record<ExperimentId, boolean>;

const KEY = 'canvian.experiments';
const DEFAULTS: Experiments = { memoria: true, maduran: true, foco: false };

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
