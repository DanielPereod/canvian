import { useSyncExternalStore } from 'react';
import { api } from './api';
import { t } from './i18n';

// Atajos de teclado: un solo sitio con todas las acciones, su tecla de fábrica
// y la que haya elegido cada uno en Configuración (se guarda en el servidor).
// Una combinación se escribe como `mod+shift+e`: `mod` es Ctrl (⌘ en Mac).

export type ActionId =
  | 'search'
  | 'switcher'
  | 'commands'
  | 'toRoot'
  | 'tasks'
  | 'diary'
  | 'newNote'
  | 'quickNote'
  | 'daily'
  | 'newSection'
  | 'newCanvas'
  | 'rename'
  | 'move'
  | 'properties'
  | 'archive'
  | 'deleteCell'
  | 'markdownSource'
  | 'zen'
  | 'wideNote'
  | 'details'
  | 'linkNote'
  | 'attach'
  | 'cycleStatus'
  | 'blockTask'
  | 'taskDone'
  | 'taskEdit'
  | 'taskLayout'
  | 'calendar'
  | 'nodes'
  | 'lantern'
  | 'sidebar'
  | 'showArchived'
  | 'toggleMode'
  | 'settings'
  | 'help'
  | 'profiles'
  | 'exportCanvas';

// Dónde sirve cada comando. `global` vale en todas partes; `list` es la
// biblioteca, el árbol y los nodos; `note`, una nota abierta.
export type View = 'list' | 'note' | 'tasks';
export type Ctx = View | 'global';

export const GROUPS = ['Ir a', 'Crear', 'Lo señalado', 'Nota', 'Tareas', 'Ver', 'Aplicación'] as const;
export type Group = (typeof GROUPS)[number];

// `key` vacío: sin tecla de fábrica (está en la paleta y se le puede poner una).
export type KeyAction = { id: ActionId; label: string; hint?: string; group: Group; ctx: Ctx[]; key: string };

// Los textos se escriben en español; `ACTIONS` los da ya en el idioma elegido.
const RAW: KeyAction[] = [
  { id: 'search', label: 'Buscar o abrir nota', hint: 'También crea notas; «a>b>c» crea en esa ruta', group: 'Ir a', ctx: ['global'], key: 'mod+p' },
  { id: 'switcher', label: 'Cambiar de nota', hint: 'Lo mismo que buscar, como en Obsidian', group: 'Ir a', ctx: ['global'], key: 'mod+o' },
  { id: 'commands', label: 'Comandos', group: 'Ir a', ctx: ['global'], key: 'mod+shift+p' },
  { id: 'toRoot', label: 'Todas las notas', group: 'Ir a', ctx: ['list'], key: '1' },
  { id: 'tasks', label: 'Tareas', hint: 'Abre o cierra la vista de tareas', group: 'Ir a', ctx: ['list', 'tasks'], key: 'a' },
  { id: 'diary', label: 'Diario', hint: 'El feed para apuntar el día a día (actívalo en Configuración › General)', group: 'Ir a', ctx: ['global'], key: '' },
  { id: 'calendar', label: 'Calendario', hint: 'Las tareas por fechas, junto a tus otros calendarios', group: 'Ir a', ctx: ['global'], key: '' },

  { id: 'newNote', label: 'Nota nueva', hint: 'En Tareas, apunta una tarea', group: 'Crear', ctx: ['list', 'tasks', 'note'], key: 'n' },
  { id: 'quickNote', label: 'Nota rápida', hint: 'Desde cualquier sitio; en Tareas, apunta una tarea. Ctrl Alt N también', group: 'Crear', ctx: ['global'], key: 'mod+n' },
  { id: 'daily', label: 'Nota de hoy', hint: 'La abre, o la crea con la fecha de hoy', group: 'Crear', ctx: ['global'], key: 'mod+shift+d' },
  { id: 'newSection', label: 'Nota dentro', hint: 'Dentro de la señalada o de la abierta', group: 'Crear', ctx: ['list', 'note'], key: 'shift+n' },
  { id: 'newCanvas', label: 'Canvas nuevo', hint: 'Tarjetas libres y flechas', group: 'Crear', ctx: ['list', 'note'], key: '' },

  { id: 'rename', label: 'Renombrar', group: 'Lo señalado', ctx: ['list'], key: 'r' },
  { id: 'move', label: 'Mover a…', hint: 'Meterla dentro de otra nota', group: 'Lo señalado', ctx: ['list', 'note', 'tasks'], key: 'm' },
  { id: 'properties', label: 'Propiedades', group: 'Lo señalado', ctx: ['list'], key: 'p' },
  { id: 'archive', label: 'Archivar o desarchivar', hint: 'Se oculta con lo que cuelga de ella', group: 'Lo señalado', ctx: ['list', 'note'], key: 'mod+shift+x' },
  { id: 'deleteCell', label: 'Borrar', group: 'Lo señalado', ctx: ['list', 'tasks'], key: 'delete' },

  { id: 'markdownSource', label: 'Ver el Markdown', hint: 'O volver al texto normal', group: 'Nota', ctx: ['note'], key: 'mod+e' },
  { id: 'zen', label: 'Modo zen', hint: 'Solo el texto, sin interfaz', group: 'Nota', ctx: ['global'], key: 'mod+shift+f' },
  { id: 'wideNote', label: 'Texto ancho', group: 'Nota', ctx: ['note'], key: '' },
  { id: 'details', label: 'Panel de detalles', hint: 'Plegarlo o mostrarlo', group: 'Nota', ctx: ['note'], key: 'mod+shift+v' },
  { id: 'linkNote', label: 'Enlazar con…', hint: 'Unir esta nota con otra', group: 'Nota', ctx: ['note'], key: '' },
  { id: 'attach', label: 'Adjuntar archivos…', group: 'Nota', ctx: ['note'], key: '' },

  { id: 'cycleStatus', label: 'Avanzar el estado', group: 'Tareas', ctx: ['tasks'], key: 'x' },
  { id: 'blockTask', label: 'Bloquear o desbloquear', group: 'Tareas', ctx: ['tasks'], key: 'shift+x' },
  { id: 'taskDone', label: 'Marcar como hecha', group: 'Tareas', ctx: ['tasks'], key: 'space' },
  { id: 'taskEdit', label: 'Editar el título', group: 'Tareas', ctx: ['tasks'], key: 'e' },
  { id: 'taskLayout', label: 'Lista o tablero', group: 'Tareas', ctx: ['tasks'], key: 'v' },


  { id: 'nodes', label: 'Ver en nodos', hint: 'La nota abierta o señalada en el centro', group: 'Ver', ctx: ['global'], key: 'mod+g' },
  { id: 'lantern', label: 'Filtrar', group: 'Ver', ctx: ['list'], key: 'f' },
  { id: 'sidebar', label: 'Barra lateral', hint: 'Plegarla o fijarla', group: 'Ver', ctx: ['global'], key: 'mod+shift+b' },
  { id: 'showArchived', label: 'Mostrar u ocultar archivadas', group: 'Ver', ctx: ['global'], key: '' },
  { id: 'toggleMode', label: 'Modo claro u oscuro', group: 'Ver', ctx: ['global'], key: 'mod+shift+l' },

  { id: 'settings', label: 'Configuración', group: 'Aplicación', ctx: ['global'], key: 'mod+,' },
  { id: 'help', label: 'Atajos', hint: 'Ctrl H también los abre', group: 'Aplicación', ctx: ['global'], key: 'shift+?' },
  { id: 'profiles', label: 'Cambiar de perfil', group: 'Aplicación', ctx: ['global'], key: '' },
  { id: 'exportCanvas', label: 'Exportar a JSON Canvas', group: 'Aplicación', ctx: ['global'], key: '' },
];

const translated = <T extends { label: string; hint?: string }>(a: T): T => ({
  ...a,
  get label() {
    return t(a.label);
  },
  get hint() {
    return a.hint && t(a.hint);
  },
});

export const ACTIONS: KeyAction[] = RAW.map(translated);

// Nombre de un grupo en el idioma elegido (`group` sigue siendo el español).
export const groupName = (g: Group) => t(g);

export const ACTION = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<ActionId, KeyAction>;

// Si un comando sirve en la vista actual.
export const appliesIn = (ctx: Ctx[], view: View) => ctx.includes('global') || ctx.includes(view);

// Teclas que no se pueden cambiar (se muestran en la lista de atajos).
const FIXED_RAW: { keys: string[]; label: string; ctx: Ctx }[] = [
  { keys: ['enter'], label: 'Abrir lo señalado', ctx: 'global' },
  { keys: ['escape'], label: 'Atrás, o cerrar lo que esté abierto', ctx: 'global' },
  { keys: ['↑', '↓'], label: 'Moverse por las listas', ctx: 'global' },
  { keys: ['backspace'], label: 'Subir un nivel', ctx: 'list' },
  { keys: ['+', '-'], label: 'En el grafo, acercar o alejar', ctx: 'list' },
  { keys: ['0'], label: 'En el grafo, encajar todo', ctx: 'list' },
  { keys: ['tab'], label: 'En el filtro, atenuar u ocultar', ctx: 'list' },
  { keys: ['arrastrar'], label: 'En el árbol, mover una nota dentro de otra', ctx: 'list' },
  { keys: ['mod+k'], label: 'Poner o quitar un enlace', ctx: 'note' },
  { keys: ['mod+clic'], label: 'Abrir el enlace', ctx: 'note' },
  { keys: ['[['], label: 'Enlazar otra nota', ctx: 'note' },
  { keys: ['/'], label: 'Insertar un bloque (títulos, listas, columnas…)', ctx: 'note' },
  { keys: ['mod+d'], label: 'Duplicar el bloque', ctx: 'note' },
  { keys: ['mod+shift+↑', 'mod+shift+↓'], label: 'Mover el bloque arriba o abajo', ctx: 'note' },
  { keys: ['arrastrar'], label: 'Con el asa ⋮⋮, mover un bloque; a un lado, en columnas', ctx: 'note' },
  { keys: ['tab'], label: 'Cambiar la agrupación', ctx: 'tasks' },
  { keys: ['j', 'k', 'h', 'l'], label: 'Moverse, como las flechas', ctx: 'tasks' },
  { keys: ['shift+←', 'shift+→'], label: 'En el tablero, cambiar de columna', ctx: 'tasks' },
  { keys: ['1…5'], label: 'En el calendario, día, semana, mes…', ctx: 'tasks' },
  { keys: ['t'], label: 'En el calendario, ir a hoy', ctx: 'tasks' },
  { keys: ['[', ']'], label: 'En el calendario, periodo anterior o siguiente', ctx: 'tasks' },
  { keys: ['shift+f10'], label: 'Menú de la tarea señalada', ctx: 'tasks' },
];
export const FIXED = FIXED_RAW.map(translated);

// ── Vista actual (la paleta y la ayuda enseñan primero lo de aquí) ──

let view: View = 'list';
const viewListeners = new Set<() => void>();
export function setView(v: View) {
  if (v === view) return;
  view = v;
  viewListeners.forEach((l) => l());
}
export const getView = () => view;
export function useView() {
  return useSyncExternalStore(
    (l) => {
      viewListeners.add(l);
      return () => viewListeners.delete(l);
    },
    () => view,
  );
}

const RESERVED = /^(escape|enter|tab|arrow(up|down|left|right)|shift\+\d)$/;
const DEFAULTS = Object.fromEntries(RAW.map((a) => [a.id, a.key])) as Record<ActionId, string>;

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

// Dos comandos chocan si comparten tecla y pueden servir en la misma vista.
const overlap = (a: ActionId, b: ActionId) => {
  const x = ACTION[a].ctx;
  const y = ACTION[b].ctx;
  return x.includes('global') || y.includes('global') || x.some((c) => y.includes(c));
};
const clash = (id: ActionId, combo: string) => (combo ? (Object.keys(current) as ActionId[]).find((a) => a !== id && current[a] === combo && overlap(a, id)) : undefined);

// Asigna una combinación. Si otra acción que vale en el mismo sitio la usaba, se intercambian.
export function bind(id: ActionId, combo: string) {
  const other = clash(id, combo);
  if (other) custom[other] = current[id];
  custom[id] = combo;
  publish();
  return { swapped: other ?? null, done: save() };
}

export function resetKey(id: ActionId) {
  delete custom[id];
  // Si la de fábrica la tenía otra acción, esa vuelve también a la suya.
  const other = clash(id, DEFAULTS[id]);
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

// A pantalla completa, Chrome deja a la página quedarse con Ctrl N (Keyboard Lock).
if (typeof document !== 'undefined') {
  type Kb = { lock?: (codes: string[]) => Promise<void>; unlock?: () => void };
  document.addEventListener('fullscreenchange', () => {
    const kb = (navigator as { keyboard?: Kb }).keyboard;
    if (document.fullscreenElement) kb?.lock?.(['KeyN']).catch(() => {});
    else kb?.unlock?.();
  });
}

// Lo que se elige en la paleta llega como una pulsación marcada con su comando,
// así cada vista lo atiende igual que su tecla, aunque no tenga ninguna.
const tagOf = (e: KeyLike) => (e as { canvianAction?: ActionId }).canvianAction;

// Segundas teclas de fábrica, mientras ninguna acción use esa combinación. Ctrl N
// se lo queda el navegador en una pestaña normal (solo llega con la app a
// pantalla completa), así que la nota rápida tiene también Ctrl Alt N.
const ALIASES: Partial<Record<ActionId, string>> = { quickNote: 'mod+alt+n' };
const hit = (id: ActionId, c: string | null) => !!c && ((!!current[id] && current[id] === c) || (ALIASES[id] === c && !isBound(c)));

export const matches = (e: KeyLike, id: ActionId) => {
  const tag = tagOf(e);
  return tag ? tag === id : hit(id, comboOf(e));
};
export const actionFor = (e: KeyLike, ids: ActionId[]) => {
  const tag = tagOf(e);
  if (tag) return ids.includes(tag) ? tag : null;
  const c = comboOf(e);
  return ids.find((id) => hit(id, c)) ?? null;
};

// Ejecuta un comando como si se hubiera pulsado su tecla.
export function runAction(id: ActionId) {
  const ev = new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'canvianAction', { value: id });
  document.body.dispatchEvent(ev);
}

// Si alguna acción usa ya esta combinación.
export const isBound = (combo: string) => Object.values(current).includes(combo);

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
  clic: 'clic',
  arrastrar: 'arrastrar',
};

// ['Ctrl', '⇧', 'E'] para pintarlo en <kbd>.
export function keyParts(combo: string): string[] {
  if (!combo) return [];
  // «?» ya lleva Mayús en todos los teclados.
  if (combo === 'shift+?') return ['?'];
  return combo.split(/\+(?!$)/).map((p) => (NAMES[p] ? t(NAMES[p]) : p.length === 1 || /^f\d+$/.test(p) ? p.toUpperCase() : p));
}
