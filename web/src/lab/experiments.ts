import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { setThemes } from '../theme';

// Ideas en prueba. Cada una se enciende y apaga desde el laboratorio (tecla E)
// para compararlas. La elección se guarda en el servidor, como el tema, y el
// navegador guarda una copia para arrancar sin esperar.
export type ExperimentId = 'memoria' | 'maduran' | 'foco' | 'celdas' | 'biblioteca';

export const EXPERIMENTS: { id: ExperimentId; name: string; hint: string }[] = [
  { id: 'memoria', name: 'Luz como memoria', hint: 'Lo que no tocas se apaga poco a poco' },
  { id: 'maduran', name: 'Tareas que maduran', hint: 'Semilla, brote y flor en vez de casillas' },
  { id: 'celdas', name: 'Mapa de celdas', hint: 'La vista de antes, con celdas que fluyen, en vez de los nodos' },
  { id: 'biblioteca', name: 'Biblioteca', hint: 'Barra lateral con tus notas en árbol, la biblioteca en lista o portadas, y un lector con panel de detalles' },
  { id: 'foco', name: 'Foco', hint: 'Ctrl P abre una lista que se funde sobre los nodos; escribe y encuentra. Esc la cierra' },
];

export type Experiments = Record<ExperimentId, boolean>;

const KEY = 'canvian.experiments';
const DEFAULTS: Experiments = { memoria: true, maduran: true, foco: true, celdas: false, biblioteca: false };

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
  // Al estrenar la Biblioteca, sus temas (claro y oscuro) vienen con ella.
  if (id === 'biblioteca' && state.biblioteca) void setThemes('biblioteca-noche', 'biblioteca').catch(() => {});
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
