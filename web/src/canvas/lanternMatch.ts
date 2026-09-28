import { parseProps, type NoteRow, type PropertyDef } from '../api';
import { tagsOf } from './tags';
import { daysUntil } from './dates';

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

const KIND: Record<string, Test> = {
  tarea: (r) => r.kind === 'task',
  nota: (r) => r.kind !== 'task' && r.kind !== 'canvas',
  canvas: (r) => r.kind === 'canvas',
  lienzo: (r) => r.kind === 'canvas',
};
const STATUS: Record<string, 'todo' | 'doing' | 'blocked' | 'done'> = { pendiente: 'todo', curso: 'doing', encurso: 'doing', bloqueada: 'blocked', bloqueo: 'blocked', hecha: 'done' };
const STATUS_LABEL = { todo: 'pendientes', doing: 'en curso', blocked: 'bloqueadas', done: 'hechas' };
const PRIORITY: Record<string, number> = { ninguna: 0, baja: 1, media: 2, alta: 3 };
const open = (r: NoteRow) => r.status !== 'done';
const due = (test: (days: number) => boolean): Test => (r) => !!r.dueAt && test(daysUntil(r.dueAt));
const DUE: Record<string, [string, Test]> = {
  hoy: ['vence hoy', due((n) => n === 0)],
  manana: ['vence mañana', due((n) => n === 1)],
  semana: ['vence esta semana', due((n) => n >= 0 && n <= 7)],
  vencida: ['vencidas', (r) => open(r) && due((n) => n < 0)(r)],
  pronto: ['vence pronto', (r) => open(r) && due((n) => n <= 2)(r)],
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
// <propiedad>:<valor>.
export function parseLens(query: string, ctx: LensContext): { test: Test | null; tokens: LensToken[] } {
  const tests: Test[] = [];
  const tokens: LensToken[] = [];
  const raws = split(query);
  const depth = Number(raws.map((r) => /^prof(?:undidad)?:(\d)$/.exec(fold(r))?.[1]).find(Boolean) ?? 1);

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
        test = (r) => r.kind === 'task' && (r.status ?? 'todo') === STATUS[value];
        label = STATUS_LABEL[STATUS[value]];
      } else {
        kind = 'text';
        label = value;
        const phrase = value.includes(' ');
        test = phrase
          ? (r) => textOf(r).folded.includes(value)
          : (r) => textOf(r).words.some((w) => w.startsWith(value));
      }
    } else if (name === 'tipo' && KIND[value]) {
      test = KIND[value];
      label = { tarea: 'tareas', nota: 'notas', zona: 'zonas' }[value as 'tarea'];
    } else if (name === 'estado' && value && pick(STATUS, value)) {
      const s = pick(STATUS, value)!;
      test = (r) => r.kind === 'task' && (r.status ?? 'todo') === s;
      label = STATUS_LABEL[s];
    } else if (name === 'prio' || name === 'prioridad') {
      const p = value ? pick(PRIORITY, value) : undefined;
      test = p === undefined ? (r) => !!r.priority : (r) => (r.priority ?? 0) === p;
      label = p === undefined ? 'con prioridad' : `prioridad ${Object.keys(PRIORITY)[p]}`;
    } else if (name === 'vence' || name === 'fecha') {
      const range = /^([<>])(\d+)d?$/.exec(value);
      if (range) {
        const n = Number(range[2]);
        test = range[1] === '<' ? (r) => open(r) && due((d) => d <= n)(r) : due((d) => d > n);
        label = range[1] === '<' ? `vence en ${n} días o menos` : `vence en más de ${n} días`;
      } else {
        const hit = value ? pick(DUE, value) : undefined;
        [label, test] = hit ?? ['con fecha', (r: NoteRow) => !!r.dueAt];
      }
    } else if (name === 'zona' || name === 'en' || name === 'dentro') {
      const zones = new Set(ctx.notes.filter((n) => fold(n.title ?? '').startsWith(value)).map((n) => n.id));
      test = (r) => (!!r.zoneId && zones.has(r.zoneId)) || zones.has(r.id);
      label = `en ${value || 'otra nota'}`;
      if (!value) test = (r) => !!r.zoneId;
      else if (!zones.size) kind = 'unknown';
    } else if (name === 'enlazado' || name === 'enlace') {
      if (!value) {
        const linked = new Set(ctx.links.flatMap((l) => [l.source, l.target]));
        test = (r) => linked.has(r.id);
        label = 'con enlaces';
      } else {
        const { ids, found } = around(ctx, value, depth);
        test = (r) => ids.has(r.id);
        label = `enlazado a «${value}»${depth > 1 ? ` · ${depth} saltos` : ''}`;
        if (!found) kind = 'unknown';
      }
    } else if (name === 'prof' || name === 'profundidad') {
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
          if (def.type === 'checkbox') return ['si', 'true', '1'].some((y) => y.startsWith(value));
          if (Array.isArray(v)) return v.some((t) => fold(t).startsWith(value));
          return fold(String(v)).startsWith(value);
        };
        label = value ? `${def.name}: ${value}` : `con ${def.name}`;
      }
    }

    if (!test) {
      kind = 'unknown';
      test = () => false;
    }
    const t = test;
    tests.push(negated ? (r) => !t(r) : t);
    tokens.push({ raw, label: negated ? `sin ${label}` : label, kind, negated });
  }
  return { test: tests.length ? (r) => tests.every((t) => t(r)) : null, tokens };
}
