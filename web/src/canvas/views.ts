import { useSyncExternalStore } from 'react';
import { ulid } from 'ulidx';
import { api, parseProps, type NoteRow, type PropertyDef, type PropertyType, type PropValue } from '../api';
import { locale, t } from '../i18n';
import { taskCount } from './tasks';

// Las vistas de cada colección, como las de una base de datos de Notion: cada
// una con su forma (tabla, lista, galería, tablero, calendario o línea de tiempo), sus filtros,
// su orden y las propiedades que enseña. Se guardan en el servidor, por
// colección, junto con la que estaba abierta.

export type ViewType = 'table' | 'list' | 'gallery' | 'board' | 'calendar' | 'timeline';
export type Zoom = 'day' | 'week' | 'month';
export type Filter = { id: string; field: string; op: string; value: PropValue };
export type Sort = { field: string; dir: 'asc' | 'desc' };
export type View = {
  id: string;
  name: string;
  type: ViewType;
  filters: Filter[];
  match: 'and' | 'or';
  sorts: Sort[];
  // Las propiedades a la vista, en orden (el título va siempre).
  fields: string[];
  // Tablero: la propiedad por la que se agrupa. Calendario y línea de tiempo: la fecha que manda.
  group: string | null;
  date: string | null;
  // Línea de tiempo: la fecha en que acaba cada nota (sin ella, son puntos) y el zoom.
  end?: string | null;
  zoom?: Zoom;
  // Tabla: el ancho de cada columna (en píxeles) que se ha ajustado a mano.
  widths?: Record<string, number>;
};
export type Coll = { active: string; views: View[] };

export const VIEW_TYPES: { id: ViewType; name: string }[] = [
  { id: 'table', name: 'Tabla' },
  { id: 'list', name: 'Lista' },
  { id: 'gallery', name: 'Galería' },
  { id: 'board', name: 'Tablero' },
  { id: 'calendar', name: 'Calendario' },
  { id: 'timeline', name: 'Línea de tiempo' },
];

// ── Propiedades ───────────────────────────────────────────────────────

// Las de siempre (título, tipo, notas dentro, tareas, fecha y última edición)
// y las personalizadas, todas con la misma forma.
export type Field = { id: string; name: string; type: PropertyType; def: PropertyDef | null; options: string[]; editable: boolean };

export const KINDS = ['note', 'collection', 'canvas'] as const;
export const kindName = (k: string) => (k === 'canvas' ? t('Canvas') : k === 'collection' ? t('Colección') : t('Nota'));

export function fieldsOf(defs: PropertyDef[]): Field[] {
  const base = (id: string, name: string, type: PropertyType, options: string[] = [], editable = false): Field => ({ id, name, type, def: null, options, editable });
  return [
    base('title', t('Título'), 'text'),
    base('kind', t('Tipo'), 'select', [...KINDS]),
    base('kids', t('Dentro'), 'number'),
    base('tasks', t('Tareas abiertas'), 'number'),
    base('due', t('Fecha'), 'date', [], true),
    base('updated', t('Editada'), 'date'),
    ...[...defs].sort((a, b) => a.position - b.position).map((d) => ({ id: d.id, name: d.name, type: d.type, def: d, options: d.options, editable: true })),
  ];
}

export function valueOf(r: NoteRow, f: Field, count: (id: string) => number): PropValue {
  switch (f.id) {
    case 'title':
      return r.title ?? '';
    case 'kind':
      return r.kind === 'canvas' ? 'canvas' : count(r.id) ? 'collection' : 'note';
    case 'kids':
      return count(r.id);
    case 'tasks':
      return taskCount(r).open.length;
    case 'due':
      return r.dueAt ? r.dueAt.slice(0, 10) : null;
    case 'updated':
      return r.updatedAt ?? null;
  }
  return parseProps(r.props)[f.id] ?? null;
}

const empty = (v: PropValue) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

// ── Filtros ───────────────────────────────────────────────────────────

export const OPS: Record<PropertyType, string[]> = {
  text: ['contains', 'notContains', 'is', 'empty', 'notEmpty'],
  url: ['contains', 'notContains', 'is', 'empty', 'notEmpty'],
  image: ['empty', 'notEmpty'],
  number: ['eq', 'neq', 'gt', 'lt', 'empty', 'notEmpty'],
  select: ['is', 'isNot', 'empty', 'notEmpty'],
  tags: ['has', 'hasNot', 'empty', 'notEmpty'],
  date: ['is', 'before', 'after', 'past7', 'next7', 'empty', 'notEmpty'],
  checkbox: ['checked', 'unchecked'],
};
const OP_NAMES: Record<string, string> = {
  contains: 'contiene',
  notContains: 'no contiene',
  is: 'es',
  isNot: 'no es',
  eq: '=',
  neq: '≠',
  gt: '>',
  lt: '<',
  has: 'incluye',
  hasNot: 'no incluye',
  before: 'antes de',
  after: 'después de',
  past7: 'últimos 7 días',
  next7: 'próximos 7 días',
  empty: 'está vacía',
  notEmpty: 'no está vacía',
  checked: 'marcada',
  unchecked: 'sin marcar',
};
export const opName = (op: string) => t(OP_NAMES[op] ?? op);
export const needsValue = (op: string) => !['empty', 'notEmpty', 'checked', 'unchecked', 'past7', 'next7'].includes(op);

const day = (v: PropValue) => (typeof v === 'string' ? v.slice(0, 10) : '');
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (days: number) => isoDay(new Date(Date.now() + days * 86_400_000));

function passes(v: PropValue, f: Filter, field: Field): boolean {
  const op = f.op;
  if (op === 'empty') return empty(v);
  if (op === 'notEmpty') return !empty(v);
  if (op === 'checked') return v === true;
  if (op === 'unchecked') return v !== true;
  // Un filtro a medias (sin valor todavía) no quita nada.
  if (needsValue(op) && empty(f.value)) return true;
  const want = f.value;
  switch (field.type) {
    case 'number': {
      const a = typeof v === 'number' ? v : null;
      const b = Number(want);
      if (op === 'neq') return a !== b;
      if (a === null) return false;
      return op === 'eq' ? a === b : op === 'gt' ? a > b : op === 'lt' ? a < b : true;
    }
    case 'date': {
      const d = day(v);
      if (op === 'past7') return !!d && d <= shift(0) && d >= shift(-7);
      if (op === 'next7') return !!d && d >= shift(0) && d <= shift(7);
      if (!d) return false;
      const w = day(want);
      return op === 'is' ? d === w : op === 'before' ? d < w : op === 'after' ? d > w : true;
    }
    case 'tags': {
      const list = (Array.isArray(v) ? v : []).map((x) => x.toLowerCase());
      const has = list.includes(String(want).toLowerCase());
      return op === 'hasNot' ? !has : has;
    }
    case 'select': {
      const same = String(v ?? '').toLowerCase() === String(want).toLowerCase();
      return op === 'isNot' ? !same : same;
    }
    default: {
      const a = String(v ?? '').toLowerCase();
      const b = String(want).toLowerCase();
      return op === 'is' ? a === b : op === 'notContains' ? !a.includes(b) : a.includes(b);
    }
  }
}

// ── Aplicar una vista ─────────────────────────────────────────────────

export function compareValues(a: PropValue, b: PropValue): number {
  // Las vacías, siempre al final.
  if (empty(a) || empty(b)) return Number(empty(a)) - Number(empty(b));
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(b === true) - Number(a === true);
  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return sa.localeCompare(sb, locale(), { numeric: true, sensitivity: 'base' });
}

export function applyView(rows: NoteRow[], view: View, fields: Field[], count: (id: string) => number): NoteRow[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const filters = view.filters.filter((f) => byId.has(f.field));
  let out = rows;
  if (filters.length) {
    const ok = (r: NoteRow, f: Filter) => passes(valueOf(r, byId.get(f.field)!, count), f, byId.get(f.field)!);
    out = rows.filter((r) => (view.match === 'or' ? filters.some((f) => ok(r, f)) : filters.every((f) => ok(r, f))));
  }
  const sorts = view.sorts.filter((s) => byId.has(s.field));
  if (sorts.length) {
    out = [...out].sort((a, b) => {
      for (const s of sorts) {
        const f = byId.get(s.field)!;
        const va = valueOf(a, f, count);
        const vb = valueOf(b, f, count);
        // Las vacías al final también al revés.
        if (empty(va) !== empty(vb)) return Number(empty(va)) - Number(empty(vb));
        const c = compareValues(va, vb);
        if (c) return s.dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }
  return out;
}

// Las propiedades por las que se puede agrupar un tablero, y las fechas de un calendario.
export const groupable = (f: Field) => f.type === 'select' || f.type === 'tags' || f.type === 'checkbox';
export const datable = (f: Field) => f.type === 'date';

// La fecha de fin de partida: una propiedad de fecha que suene a final.
export const endOf = (fields: Field[]) => fields.find((f) => f.def && datable(f) && /fin|final|acaba|termina|hasta|entrega|end|until|due/i.test(f.name))?.id ?? null;

export function newView(type: ViewType, defs: PropertyDef[], name?: string): View {
  const fields = fieldsOf(defs);
  const custom = fields.filter((f) => f.def).map((f) => f.id);
  const firstGroup = fields.find((f) => f.def && (f.type === 'select' || f.type === 'checkbox'))?.id ?? 'kind';
  const shown: Record<ViewType, string[]> = {
    table: ['kind', 'due', ...custom.slice(0, 5), 'updated'],
    list: ['kind', 'kids', 'updated'],
    gallery: ['updated'],
    board: ['due'],
    calendar: [],
    timeline: [],
  };
  return {
    id: ulid(),
    name: name ?? t(VIEW_TYPES.find((v) => v.id === type)!.name),
    type,
    filters: [],
    match: 'and',
    sorts: [],
    fields: shown[type],
    group: type === 'board' ? firstGroup : null,
    date: type === 'calendar' || type === 'timeline' ? 'due' : null,
    end: type === 'timeline' ? endOf(fields) : null,
  };
}

// ── Guardar ───────────────────────────────────────────────────────────

const LOCAL = 'canvian:views';
let current: Record<string, Coll> = {};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const valid = (v: unknown): v is Record<string, Coll> => !!v && typeof v === 'object' && !Array.isArray(v);

function apply(next: Record<string, Coll>) {
  current = next;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(next));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

try {
  const raw = localStorage.getItem(LOCAL);
  const saved = raw ? JSON.parse(raw) : null;
  if (valid(saved)) current = saved;
} catch {
  // Sin almacenamiento local se empieza en blanco.
}

export function loadViews() {
  return api
    .prefs()
    .then((p) => {
      // Con un cambio nuestro aún por salir, manda el nuestro.
      if (!timer && valid(p.views)) apply(p.views);
    })
    .catch(() => {});
}

// Al momento en pantalla; al servidor, un poco después (escribir en un filtro
// no manda una petición por tecla).
export function saveColl(key: string, coll: Coll) {
  apply({ ...current, [key]: coll });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void api.savePref('views', current).catch(() => {});
  }, 400);
}

export function useViews() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
