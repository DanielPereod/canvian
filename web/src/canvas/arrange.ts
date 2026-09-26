import { parseProps, type NoteInput, type NoteRow, type PropertyDef } from '../api';
import { daysUntil } from './dates';

// «Reordenar»: las notas que alumbra la lente se colocan en columnas según un
// criterio. Es un kanban al momento: no hay pantalla aparte y al salir cada
// nota vuelve a su sitio. Arrastrar una nota a otra columna cambia su valor.

export const COL_W = 260;
export const COL_GAP = 56;
export const CARD_GAP = 14;
export const HEADER_H = 64;

export type Column = { key: string; title: string };
export type GroupBy = { id: string; name: string };

export const BASE_GROUPS: GroupBy[] = [
  { id: 'status', name: 'Estado' },
  { id: 'priority', name: 'Prioridad' },
  { id: 'due', name: 'Fecha' },
];

export function groupOptions(defs: PropertyDef[]): GroupBy[] {
  return [...BASE_GROUPS, ...defs.filter((d) => d.type === 'select' || d.type === 'checkbox').map((d) => ({ id: d.id, name: d.name }))];
}

const dueKey = (r: NoteRow) => {
  if (!r.dueAt) return 'none';
  const n = daysUntil(r.dueAt);
  if (n < 0) return r.status === 'done' ? 'later' : 'overdue';
  if (n === 0) return 'today';
  if (n <= 7) return 'week';
  return 'later';
};

export function columnsFor(groupBy: string, defs: PropertyDef[], rows: NoteRow[]): { columns: Column[]; keyOf: (r: NoteRow) => string } {
  if (groupBy === 'priority')
    return {
      columns: [
        { key: '3', title: 'Alta' },
        { key: '2', title: 'Media' },
        { key: '1', title: 'Baja' },
        { key: '0', title: 'Sin prioridad' },
      ],
      keyOf: (r) => String(r.priority ?? 0),
    };
  if (groupBy === 'due')
    return {
      columns: [
        { key: 'overdue', title: 'Vencidas' },
        { key: 'today', title: 'Hoy' },
        { key: 'week', title: 'Esta semana' },
        { key: 'later', title: 'Más adelante' },
        { key: 'none', title: 'Sin fecha' },
      ],
      keyOf: dueKey,
    };
  const def = defs.find((d) => d.id === groupBy);
  if (def?.type === 'checkbox')
    return {
      columns: [
        { key: 'yes', title: def.name },
        { key: 'no', title: `Sin ${def.name.toLowerCase()}` },
      ],
      keyOf: (r) => (parseProps(r.props)[def.id] === true ? 'yes' : 'no'),
    };
  if (def) {
    const opts = [...def.options];
    for (const r of rows) {
      const v = parseProps(r.props)[def.id];
      if (typeof v === 'string' && v && !opts.includes(v)) opts.push(v);
    }
    return {
      columns: [...opts.map((o) => ({ key: `v:${o}`, title: o })), { key: 'none', title: `Sin ${def.name.toLowerCase()}` }],
      keyOf: (r) => {
        const v = parseProps(r.props)[def.id];
        return typeof v === 'string' && v ? `v:${v}` : 'none';
      },
    };
  }
  const columns = [
    { key: 'todo', title: 'Pendiente' },
    { key: 'doing', title: 'En curso' },
    { key: 'done', title: 'Hecha' },
  ];
  if (rows.some((r) => r.kind !== 'task')) columns.unshift({ key: 'note', title: 'Notas' });
  return { columns, keyOf: (r) => (r.kind === 'task' ? (r.status ?? 'todo') : 'note') };
}

const order = (a: NoteRow, b: NoteRow) =>
  (b.priority ?? 0) - (a.priority ?? 0) ||
  (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
  (a.title ?? '').localeCompare(b.title ?? '');

// Posición de cada columna y de cada nota, centradas en `origin`.
export function layout(
  items: { row: NoteRow; height: number }[],
  columns: Column[],
  keyOf: (r: NoteRow) => string,
  origin: { x: number; y: number },
  hideEmpty: boolean,
) {
  const groups = new Map(columns.map((c) => [c.key, [] as { row: NoteRow; height: number }[]]));
  for (const it of items) groups.get(keyOf(it.row))?.push(it);
  const shown = columns.filter((c) => !hideEmpty || groups.get(c.key)!.length);
  const width = shown.length * COL_W + (shown.length - 1) * COL_GAP;
  const left = origin.x - width / 2;
  const positions = new Map<string, { x: number; y: number }>();
  const cols = shown.map((c, i) => {
    const x = left + i * (COL_W + COL_GAP);
    let y = origin.y + HEADER_H;
    const list = groups.get(c.key)!.sort((a, b) => order(a.row, b.row));
    for (const it of list) {
      positions.set(it.row.id, { x, y });
      y += it.height + CARD_GAP;
    }
    return { ...c, x, y: origin.y, count: list.length, bottom: y };
  });
  return { cols, positions, left };
}

// Qué cambia en una nota al soltarla en otra columna (null si no se puede).
export function dropChange(groupBy: string, key: string, defs: PropertyDef[], row: NoteRow): NoteInput | null {
  if (groupBy === 'status') {
    if (key === 'note') return row.kind === 'task' ? { kind: 'text' } : null;
    const status = key as 'todo' | 'doing' | 'done';
    return { kind: 'task', status, doneAt: status === 'done' ? new Date().toISOString() : null };
  }
  if (groupBy === 'priority') return { priority: Number(key) || null };
  if (groupBy === 'due') {
    const day = (n: number) => {
      const d = new Date(Date.now() + n * 86_400_000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    return ({ today: { dueAt: day(0) }, week: { dueAt: day(7) }, later: { dueAt: day(30) }, none: { dueAt: null } } as Record<string, NoteInput>)[key] ?? null;
  }
  const def = defs.find((d) => d.id === groupBy);
  if (!def) return null;
  const { [def.id]: _old, ...rest } = parseProps(row.props);
  if (def.type === 'checkbox') return { props: key === 'yes' ? { ...rest, [def.id]: true } : rest };
  return { props: key === 'none' ? rest : { ...rest, [def.id]: key.slice(2) } };
}
