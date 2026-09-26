import type { NoteRow } from '../api';

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const KIND: Record<string, (r: NoteRow) => boolean> = {
  tarea: (r) => r.kind === 'task',
  nota: (r) => r.kind !== 'task' && r.kind !== 'zone',
  zona: (r) => r.kind === 'zone',
};
const STATUS: Record<string, string> = { pendiente: 'todo', curso: 'doing', encurso: 'doing', hecha: 'done' };

// Qué notas alumbra la linterna. Las palabras buscan por inicio de palabra sin
// importar tildes; «tipo:tarea» y «estado:pendiente|curso|hecha» afinan.
export function lanternMatcher(query: string): ((r: NoteRow) => boolean) | null {
  const tests: ((r: NoteRow) => boolean)[] = [];
  for (const raw of fold(query).split(/\s+/).filter(Boolean)) {
    const [key, value] = raw.includes(':') ? raw.split(':', 2) : [null, raw];
    if (key === 'tipo' && value && KIND[value]) tests.push(KIND[value]);
    else if (key === 'estado' && value) {
      const status = Object.entries(STATUS).find(([k]) => k.startsWith(value))?.[1];
      if (status) tests.push((r) => r.kind === 'task' && (r.status ?? 'todo') === status);
    } else if (value) {
      tests.push((r) => fold(`${r.title ?? ''} ${r.bodyText ?? ''}`).split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(value)));
    }
  }
  return tests.length ? (r) => tests.every((t) => t(r)) : null;
}
