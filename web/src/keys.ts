import { useSyncExternalStore } from 'react';
import { api } from './api';

// Atajos de teclado: un solo sitio con todas las acciones, su tecla de fábrica
// y la que haya elegido cada uno en Configuración (se guarda en el servidor).
// Una combinación se escribe como `mod+shift+e`: `mod` es Ctrl (⌘ en Mac).

export type ActionId =
  | 'newNote'
  | 'newSection'
  | 'newCanvas'
  | 'toggleTask'
  | 'cycleStatus'
  | 'blockTask'
  | 'properties'
  | 'deleteCell'
  | 'rename'
  | 'archive'
  | 'showArchived'
  | 'toRoot'
  | 'tasks'
  | 'organize'
  | 'nodes'
  | 'lantern'
  | 'search'
  | 'commands'
  | 'profiles'
  | 'background'
  | 'toggleMode'
  | 'exportCanvas'
  | 'help'
  | 'settings'
  | 'sidebar';

export type KeyAction = { id: ActionId; label: string; group: 'Notas' | 'Vistas y paneles'; key: string };

export const ACTIONS: KeyAction[] = [
  { id: 'newNote', label: 'Nota nueva (en la vista de tareas, apuntar una tarea rápida)', group: 'Notas', key: 'n' },
  { id: 'newSection', label: 'Nota dentro de la señalada', group: 'Notas', key: 'g' },
  { id: 'newCanvas', label: 'Canvas nuevo (tarjetas libres y flechas)', group: 'Notas', key: 'c' },
  { id: 'toggleTask', label: 'Convertir en tarea o en nota', group: 'Notas', key: 't' },
  { id: 'cycleStatus', label: 'Avanzar el estado de una tarea', group: 'Notas', key: 'x' },
  { id: 'blockTask', label: 'Bloquear o desbloquear una tarea', group: 'Notas', key: 'shift+x' },
  { id: 'properties', label: 'Propiedades', group: 'Notas', key: 'p' },
  { id: 'deleteCell', label: 'Borrar lo señalado', group: 'Notas', key: 'delete' },
  { id: 'rename', label: 'Renombrar la nota señalada', group: 'Notas', key: 'r' },
  { id: 'archive', label: 'Archivar o desarchivar la nota abierta o señalada (se oculta con lo que cuelga de ella)', group: 'Notas', key: 'mod+shift+x' },
  { id: 'showArchived', label: 'Mostrar u ocultar las notas archivadas', group: 'Vistas y paneles', key: 'mod+shift+h' },
  { id: 'toRoot', label: 'Volver a todas las notas', group: 'Notas', key: '1' },
  { id: 'tasks', label: 'Vista de tareas activas', group: 'Vistas y paneles', key: 'a' },
  { id: 'organize', label: 'Ordenar notas en secciones', group: 'Vistas y paneles', key: 'o' },
  { id: 'nodes', label: 'Modo nodo (activar o quitar): la nota abierta o señalada en el centro, con sus relaciones', group: 'Vistas y paneles', key: 'mod+g' },
  { id: 'lantern', label: 'Linterna (filtrar)', group: 'Vistas y paneles', key: 'f' },
  { id: 'search', label: 'Buscar o crear notas', group: 'Vistas y paneles', key: 'mod+p' },
  { id: 'commands', label: 'Paleta de comandos', group: 'Vistas y paneles', key: 'mod+shift+p' },
  { id: 'profiles', label: 'Cambiar de perfil', group: 'Vistas y paneles', key: 'mod+alt+p' },
  { id: 'background', label: 'Fondo', group: 'Vistas y paneles', key: 'b' },
  { id: 'toggleMode', label: 'Cambiar entre modo claro y oscuro', group: 'Vistas y paneles', key: 'mod+shift+l' },
  { id: 'exportCanvas', label: 'Exportar a JSON Canvas', group: 'Vistas y paneles', key: 'mod+shift+e' },
  { id: 'help', label: 'Lista de atajos', group: 'Vistas y paneles', key: 'mod+h' },
  { id: 'settings', label: 'Configuración', group: 'Vistas y paneles', key: 'mod+,' },
  { id: 'sidebar', label: 'Plegar o fijar la barra lateral', group: 'Vistas y paneles', key: 'mod+.' },
];

// Teclas que no se pueden cambiar (se muestran en la lista de atajos).
export const FIXED: { keys: string[]; label: string }[] = [
  { keys: ['clic'], label: 'Entrar en una colección o abrir una nota' },
  { keys: ['arrastrar'], label: 'En los nodos, mover una nota dentro de otra' },
  { keys: ['enter'], label: 'Entrar o abrir lo señalado' },
  { keys: ['escape'], label: 'Atrás, o cerrar lo que esté abierto' },
  { keys: ['shift+1…9'], label: 'Abrir una lente guardada' },
  { keys: ['tab'], label: 'En la linterna, cambiar el modo; en la vista de tareas, cambiar la agrupación' },
  { keys: ['↑', '↓'], label: 'Moverse por las listas' },
  { keys: ['mod+clic'], label: 'En una nota, abrir el enlace' },
  { keys: ['mod+k'], label: 'En una nota, poner o quitar un enlace' },
];

const RESERVED = /^(escape|enter|tab|arrow(up|down|left|right)|shift\+\d)$/;
const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])) as Record<ActionId, string>;

let custom: Partial<Record<ActionId, string>> = {};
let current: Record<ActionId, string> = { ...DEFAULTS };
const listeners = new Set<() => void>();
const publish = () => {
  current = { ...DEFAULTS, ...custom };
  listeners.forEach((l) => l());
};

export function useKeymap() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function loadKeymap() {
  return api
    .prefs()
    .then((p) => {
      const saved = (p.keymap ?? {}) as Record<string, string>;
      custom = Object.fromEntries(Object.entries(saved).filter(([id]) => id in DEFAULTS)) as typeof custom;
      publish();
    })
    .catch(() => {});
}

const save = () => {
  const changed = Object.fromEntries(Object.entries(custom).filter(([id, k]) => DEFAULTS[id as ActionId] !== k));
  return Object.keys(changed).length ? api.savePref('keymap', changed) : api.deletePref('keymap');
};

// Asigna una combinación. Si otra acción la usaba, se intercambian.
export function bind(id: ActionId, combo: string) {
  const other = (Object.keys(current) as ActionId[]).find((a) => a !== id && current[a] === combo);
  if (other) custom[other] = current[id];
  custom[id] = combo;
  publish();
  return { swapped: other ?? null, done: save() };
}

export function resetKey(id: ActionId) {
  delete custom[id];
  // Si la de fábrica la tenía otra acción, esa vuelve también a la suya.
  const other = (Object.keys(current) as ActionId[]).find((a) => a !== id && current[a] === DEFAULTS[id]);
  if (other) delete custom[other];
  publish();
  return save();
}

export function resetAll() {
  custom = {};
  publish();
  return save();
}

export const isDefault = (id: ActionId) => current[id] === DEFAULTS[id];

// ── Leer el teclado ───────────────────────────────────────────────

type KeyLike = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

// Combinación de una pulsación, o null si solo se pulsó un modificador.
export function comboOf(e: KeyLike): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead'].includes(e.key)) return null;
  // Letras y números por su posición, para que ⇧ o Alt no cambien el carácter.
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(e.code)
      ? e.code.slice(5)
      : e.key === ' '
        ? 'space'
        : e.key.toLowerCase();
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  return [...parts, key].join('+');
}

export const matches = (e: KeyLike, id: ActionId) => comboOf(e) === current[id];
export const actionFor = (e: KeyLike, ids: ActionId[]) => {
  const c = comboOf(e);
  return ids.find((id) => current[id] === c) ?? null;
};

export const reserved = (combo: string) => RESERVED.test(combo);

// Con Configuración o la lista de atajos abiertas, el resto no escucha.
export const keysBlocked = () => !!document.querySelector('[data-keys-modal]');

// ── Mostrar ───────────────────────────────────────────────────────

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const NAMES: Record<string, string> = {
  mod: MAC ? '⌘' : 'Ctrl',
  alt: MAC ? '⌥' : 'Alt',
  shift: '⇧',
  delete: 'Supr',
  backspace: '⌫',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Espacio',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

// ['Ctrl', '⇧', 'E'] para pintarlo en <kbd>.
export function keyParts(combo: string): string[] {
  if (!combo) return [];
  return combo.split(/\+(?!$)/).map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}
