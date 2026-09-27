import { useSyncExternalStore } from 'react';
import { api } from '../api';

// Ideas en prueba. Cada una se enciende y apaga desde el laboratorio (tecla E)
// para compararlas. La elección se guarda en el servidor, como el tema, y el
// navegador guarda una copia para arrancar sin esperar.
export type ExperimentId = 'memoria' | 'maduran' | 'foco' | 'celdas';

export const EXPERIMENTS: { id: ExperimentId; name: string; hint: string }[] = [
  { id: 'memoria', name: 'Luz como memoria', hint: 'Lo que no tocas se apaga poco a poco' },
  { id: 'maduran', name: 'Tareas que maduran', hint: 'Semilla, brote y flor en vez de casillas' },
  { id: 'celdas', name: 'Mapa de celdas', hint: 'La vista de antes, con celdas que fluyen, en vez de los nodos' },
  { id: 'foco', name: 'Foco', hint: 'La portada es una lista que se funde; escribe y encuentra. Esc lleva al mapa' },
];

export type Experiments = Record<ExperimentId, boolean>;

const KEY = 'canvian.experiments';
const DEFAULTS: Experiments = { memoria: true, maduran: true, foco: true, celdas: false };

function load(): Experiments {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let state = load();
const listeners = new Set<() => void>();

function keep(next: Experiments) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Sin almacenamiento local vale lo que diga el servidor al cargar.
  }
  for (const l of listeners) l();
}

// Al entrar: manda lo guardado en el servidor. Si aún no hay nada allí, sube
// lo que este navegador tenía elegido.
export function loadExperiments() {
  return api
    .prefs()
    .then((p) => {
      const saved = p.experiments as Partial<Experiments> | undefined;
      if (saved) keep({ ...DEFAULTS, ...saved });
      else if (localStorage.getItem(KEY)) return api.savePref('experiments', state);
    })
    .catch(() => {});
}

export function toggleExperiment(id: ExperimentId) {
  keep({ ...state, [id]: !state[id] });
  api.savePref('experiments', state).catch(() => {});
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
