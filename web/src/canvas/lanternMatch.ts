import { parseProps, type NoteRow, type PropertyDef } from '../api';
import { t as tr, tn } from '../i18n';
import { tagsOf } from './tags';
import { daysUntil } from './dates';
import { tasksOf, type Task } from './tasks';

type Test = (r: NoteRow) => boolean;

export type LensContext = {
  defs: PropertyDef[];
  notes: NoteRow[];
  links: { source: string; target: string }[];
};

// Cada trozo de la consulta, para dibujarlo como chip.
export type LensToken = { raw: string; label: string; kind: 'text' | 'filter' | 'unknown'; negated: boolean };

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const key = (s: string) => fold(s).replace(/\s+/g, '');
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}#]+/u);

// El texto normalizado de cada nota se recuerda mientras la nota no cambie:
// con miles de notas, normalizar en cada tecla de la linterna se notaba.
const textCache = new WeakMap<NoteRow, { folded: string; words: string[] }>();
function textOf(r: NoteRow) {
  let t = textCache.get(r);
  if (!t) {
    const raw = `${r.title ?? ''} ${r.bodyText ?? ''}`;
    t = { folded: fold(raw), words: words(raw) };
    textCache.set(r, t);
  }
  return t;
}

// Las tareas son casillas dentro de las notas: «tipo:tarea», «estado:» y
// «vence:» alumbran las notas que tienen alguna así.
const withTask = (test: (t: Task) => boolean): Test => (r) => tasksOf(r).some(test);
const KIND: Record<string, Test> = {
  tarea: withTask((t) => t.status !== 'done'),
  tareas: withTask(() => true),
  nota: (r) => r.kind !== 'canvas',
  canvas: (r) => r.kind === 'canvas',
  lienzo: (r) => r.kind === 'canvas',
  task: withTask((t) => t.status !== 'done'),
  tasks: withTask(() => true),
  note: (r) => r.kind !== 'canvas',
};
const KIND_LABEL: Record<string, string> = { tarea: 'con tareas pendientes', tareas: 'con tareas', nota: 'notas', canvas: 'canvas', lienzo: 'canvas', task: 'con tareas pendientes', tasks: 'con tareas', note: 'notas' };
type Status = 'todo' | 'doing' | 'blocked' | 'done';
const STATUS: Record<string, Status> = { pendiente: 'todo', curso: 'doing', encurso: 'doing', bloqueada: 'blocked', bloqueo: 'blocked', hecha: 'done' };
// Tras «estado:» / «status:» también valen en inglés (a secas no: «todo» es una palabra).
const STATUS_ANY: Record<string, Status> = { ...STATUS, todo: 'todo', pending: 'todo', doing: 'doing', inprogress: 'doing', blocked: 'blocked', done: 'done' };
const STATUS_LABEL = { todo: 'con tareas pendientes', doing: 'con tareas en curso', blocked: 'con tareas bloqueadas', done: 'con tareas hechas' };
const PRIORITY: Record<string, number> = { ninguna: 0, baja: 1, media: 2, alta: 3, none: 0, low: 1, medium: 2, high: 3 };
const PRIORITY_LABEL = ['prioridad ninguna', 'prioridad baja', 'prioridad media', 'prioridad alta'];
// Vence: la fecha de la nota o la de alguna de sus tareas sin hacer.
const due = (test: (days: number) => boolean): Test => (r) => (!!r.dueAt && test(daysUntil(r.dueAt))) || withTask((t) => t.status !== 'done' && !!t.dueAt && test(daysUntil(t.dueAt)))(r);
const open = due;
const DUE: Record<string, [string, Test]> = {
  hoy: ['vence hoy', due((n) => n === 0)],
  manana: ['vence mañana', due((n) => n === 1)],
  semana: ['vence esta semana', due((n) => n >= 0 && n <= 7)],
  vencida: ['vencidas', open((n) => n < 0)],
  pronto: ['vence pronto', open((n) => n <= 2)],
  today: ['vence hoy', due((n) => n === 0)],
  tomorrow: ['vence mañana', due((n) => n === 1)],
  week: ['vence esta semana', due((n) => n >= 0 && n <= 7)],
  overdue: ['vencidas', open((n) => n < 0)],
  soon: ['vence pronto', open((n) => n <= 2)],
};
const pick = <T,>(table: Record<string, T>, value: string) => Object.entries(table).find(([k]) => k.startsWith(value))?.[1];

// Parte la consulta respetando comillas: enlazado:"Plan de viaje" -hecha
function split(query: string) {
  const out: string[] = [];
  for (const m of query.matchAll(/(-?[^\s:"]+:"[^"]*"?|-?"[^"]*"?|\S+)/g)) out.push(m[0]);
  return out;
}
const unquote = (s: string) => s.replace(/^"|"$/g, '');

// Las notas a como mucho `depth` saltos de las que coinciden con `anchor`.
function around(ctx: LensContext, anchor: string, depth: number) {
  const starts = ctx.notes.filter((n) => fold(n.title ?? n.bodyText ?? '').includes(anchor)).map((n) => n.id);
  const adjacent = new Map<string, string[]>();
  for (const l of ctx.links) {
    adjacent.set(l.source, [...(adjacent.get(l.source) ?? []), l.target]);
    adjacent.set(l.target, [...(adjacent.get(l.target) ?? []), l.source]);
  }
  const seen = new Set(starts);
  let frontier = starts;
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of adjacent.get(id) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n));
    frontier = next;
  }
  return { ids: seen, found: starts.length };
}

// Qué notas alumbra una lente. Palabras sueltas buscan por inicio de palabra sin
// importar tildes; un «-» delante niega. Filtros: tipo:, estado:, prio:, vence:
// (también vence:<7d / >7d), zona:, #etiqueta, enlazado:"título" con prof:N y
// <propiedad>:<valor>. Los filtros se entienden también en inglés (type:,
// status:, priority:, due:, in:, linked:, depth:).
export function parseLens(query: string, ctx: LensContext): { test: Test | null; tokens: LensToken[] } {
  const tests: Test[] = [];
  const tokens: LensToken[] = [];
  const raws = split(query);
  const depth = Number(raws.map((r) => /^(?:prof(?:undidad)?|depth):(\d)$/.exec(fold(r))?.[1]).find(Boolean) ?? 1);

  for (const raw of raws) {
    const negated = raw.startsWith('-') && raw.length > 1;
    const body = fold(negated ? raw.slice(1) : raw);
    const colon = body.indexOf(':');
    const name = colon > 0 && !body.startsWith('"') ? body.slice(0, colon) : null;
    const value = unquote(name === null ? body : body.slice(colon + 1));
    let test: Test | null = null;
    let label = raw;
    let kind: LensToken['kind'] = 'filter';

    if (name === null) {
      if (!value) continue;
      if (value.startsWith('#') && value.length > 1) {
        const tag = value.slice(1);
        const zones = new Set(ctx.notes.filter((n) => key(n.title ?? '').startsWith(tag)).map((n) => n.id));
        test = (r) =>
          textOf(r).words.some((w) => w.startsWith(value)) || (!!r.zoneId && zones.has(r.zoneId)) || tagsOf(r, ctx.defs).some((t) => key(t).startsWith(tag));
        label = `#${tag}`;
      } else if (STATUS[value]) {
        // «hecha» o «-hecha» a secas se entienden como estado.
        const s = STATUS[value];
        test = withTask((t) => t.status === s);
        label = tr(STATUS_LABEL[STATUS[value]]);
      } else {
        kind = 'text';
        label = value;
        const phrase = value.includes(' ');
        test = phrase
          ? (r) => textOf(r).folded.includes(value)
          : (r) => textOf(r).words.some((w) => w.startsWith(value));
      }
    } else if ((name === 'tipo' || name === 'type') && KIND[value]) {
      test = KIND[value];
      label = KIND_LABEL[value] ? tr(KIND_LABEL[value]) : value;
    } else if ((name === 'estado' || name === 'status') && value && pick(STATUS_ANY, value)) {
      const s = pick(STATUS_ANY, value)!;
      test = withTask((t) => t.status === s);
      label = tr(STATUS_LABEL[s]);
    } else if (name === 'prio' || name === 'prioridad' || name === 'priority') {
      const p = value ? pick(PRIORITY, value) : undefined;
      test = p === undefined ? withTask((t) => t.status !== 'done' && !!t.priority) : p ? withTask((t) => t.status !== 'done' && t.priority === p) : (r) => !withTask((t) => t.status !== 'done' && !!t.priority)(r);
      label = tr(p === undefined ? 'con prioridad' : PRIORITY_LABEL[p]);
    } else if (name === 'vence' || name === 'fecha' || name === 'due' || name === 'date') {
      const range = /^([<>])(\d+)d?$/.exec(value);
      if (range) {
        const n = Number(range[2]);
        test = range[1] === '<' ? open((d) => d <= n) : due((d) => d > n);
        label = range[1] === '<' ? tn(n, 'vence en {n} día o menos', 'vence en {n} días o menos') : tn(n, 'vence en más de {n} día', 'vence en más de {n} días');
      } else {
        const hit = value ? pick(DUE, value) : undefined;
        [label, test] = hit ?? ['con fecha', due(() => true)];
        label = tr(label);
      }
    } else if (name === 'zona' || name === 'en' || name === 'dentro' || name === 'zone' || name === 'in' || name === 'inside') {
      const zones = new Set(ctx.notes.filter((n) => fold(n.title ?? '').startsWith(value)).map((n) => n.id));
      test = (r) => (!!r.zoneId && zones.has(r.zoneId)) || zones.has(r.id);
      label = value ? tr('en {name}', { name: value }) : tr('en otra nota');
      if (!value) test = (r) => !!r.zoneId;
      else if (!zones.size) kind = 'unknown';
    } else if (name === 'enlazado' || name === 'enlace' || name === 'linked' || name === 'link') {
      if (!value) {
        const linked = new Set(ctx.links.flatMap((l) => [l.source, l.target]));
        test = (r) => linked.has(r.id);
        label = tr('con enlaces');
      } else {
        const { ids, found } = around(ctx, value, depth);
        test = (r) => ids.has(r.id);
        label = tr('enlazado a «{name}»', { name: value }) + (depth > 1 ? ` · ${tn(depth, '{n} salto', '{n} saltos')}` : '');
        if (!found) kind = 'unknown';
      }
    } else if (name === 'prof' || name === 'profundidad' || name === 'depth') {
      continue;
    } else {
      const def = ctx.defs.find((d) => key(d.name).startsWith(name));
      if (!def) {
        kind = 'unknown';
        test = () => false;
      } else {
        test = (r) => {
          const v = parseProps(r.props)[def.id];
          if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) return false;
          if (!value) return true;
          if (def.type === 'checkbox') return ['si', 'yes', 'true', '1'].some((y) => y.startsWith(value));
          if (Array.isArray(v)) return v.some((t) => fold(t).startsWith(value));
          return fold(String(v)).startsWith(value);
        };
        label = value ? `${def.name}: ${value}` : tr('con {name}', { name: def.name });
      }
    }

    if (!test) {
      kind = 'unknown';
      test = () => false;
    }
    const t = test;
    tests.push(negated ? (r) => !t(r) : t);
    tokens.push({ raw, label: negated ? tr('sin {label}', { label }) : label, kind, negated });
  }
  return { test: tests.length ? (r) => tests.every((t) => t(r)) : null, tokens };
}
