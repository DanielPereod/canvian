import { parseProps, type NoteRow, type PropertyDef } from '../api';
import { daysUntil } from './dates';

type Test = (r: NoteRow) => boolean;

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const key = (s: string) => fold(s).replace(/\s+/g, '');

const KIND: Record<string, Test> = {
  tarea: (r) => r.kind === 'task',
  nota: (r) => r.kind !== 'task' && r.kind !== 'zone',
  zona: (r) => r.kind === 'zone',
};
const STATUS: Record<string, string> = { pendiente: 'todo', curso: 'doing', encurso: 'doing', hecha: 'done' };
const PRIORITY: Record<string, number> = { ninguna: 0, baja: 1, media: 2, alta: 3 };
const open = (r: NoteRow) => r.status !== 'done';
const due = (test: (days: number) => boolean): Test => (r) => !!r.dueAt && test(daysUntil(r.dueAt));
const DUE: Record<string, Test> = {
  hoy: due((n) => n === 0),
  manana: due((n) => n === 1),
  semana: due((n) => n >= 0 && n <= 7),
  vencida: (r) => open(r) && due((n) => n < 0)(r),
  pronto: (r) => open(r) && due((n) => n <= 2)(r),
  fecha: (r) => !!r.dueAt,
};
const pick = <T,>(table: Record<string, T>, value: string) => Object.entries(table).find(([k]) => k.startsWith(value))?.[1];

// Qué notas alumbra la linterna. Las palabras buscan por inicio de palabra sin
// importar tildes. Filtros: tipo:tarea, estado:pendiente|curso|hecha,
// prio:alta|media|baja, vence:hoy|semana|vencida|pronto y <propiedad>:<valor>
// (o <propiedad>: a secas para «tiene algo»).
export function lanternMatcher(query: string, defs: PropertyDef[] = []): Test | null {
  const tests: Test[] = [];
  for (const raw of fold(query).split(/\s+/).filter(Boolean)) {
    const colon = raw.indexOf(':');
    const name = colon >= 0 ? raw.slice(0, colon) : null;
    const value = colon >= 0 ? raw.slice(colon + 1) : raw;
    if (name === null) {
      tests.push((r) => fold(`${r.title ?? ''} ${r.bodyText ?? ''}`).split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(value)));
      continue;
    }
    if (name === 'tipo' && value && KIND[value]) {
      tests.push(KIND[value]);
      continue;
    }
    if (name === 'estado') {
      const status = value && pick(STATUS, value);
      if (status) tests.push((r) => r.kind === 'task' && (r.status ?? 'todo') === status);
      continue;
    }
    if (name === 'prio' || name === 'prioridad') {
      const p = value ? pick(PRIORITY, value) : undefined;
      tests.push(p === undefined ? (r) => !!r.priority : (r) => (r.priority ?? 0) === p);
      continue;
    }
    if (name === 'vence' || name === 'fecha') {
      tests.push((value && pick(DUE, value)) || DUE.fecha);
      continue;
    }
    const def = defs.find((d) => key(d.name).startsWith(name));
    if (!def) {
      tests.push(() => false);
      continue;
    }
    tests.push((r) => {
      const v = parseProps(r.props)[def.id];
      if (v === undefined || v === null || v === '' || v === false) return false;
      if (!value) return true;
      if (def.type === 'checkbox') return ['si', 'true', '1'].some((y) => y.startsWith(value));
      return fold(String(v)).startsWith(value);
    });
  }
  return tests.length ? (r) => tests.every((t) => t(r)) : null;
}
