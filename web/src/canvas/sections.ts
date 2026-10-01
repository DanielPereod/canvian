import type { NoteRow } from '../api';
import { daysUntil } from './dates';
import { tasksOf } from './tasks';

// Las notas como un árbol: cualquier nota puede ser madre de otras (`zoneId`
// es su madre). Aquí están la madre de cada una, las rutas «Padre>Hijo» y la
// importancia con la que se ordenan y se dibujan en los nodos.

const DAY = 86_400_000;

export type Rect = { x: number; y: number; w: number; h: number };
export const bounds = (rs: Rect[]): Rect => {
  if (!rs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x || 1, h: Math.max(...rs.map((r) => r.y + r.h)) - y || 1 };
};

// Importancia de una nota: enlaces, sus tareas (en curso o a punto
// de vencer), si la tocaste hace poco y cuánto texto tiene.
export function importanceOf(row: NoteRow, degree: number, now = Date.now()) {
  let imp = 1 + 0.55 * Math.min(degree, 8);
  const open = tasksOf(row).filter((t) => t.status !== 'done');
  if (open.some((t) => t.status === 'doing')) imp += 0.8;
  if (open.some((t) => t.dueAt && daysUntil(t.dueAt) <= 2) || (row.dueAt && daysUntil(row.dueAt) <= 2)) imp += 1;
  imp += 0.15 * Math.min(open.length, 6);
  if (row.updatedAt) imp += 1.5 * Math.exp(-(now - Date.parse(row.updatedAt)) / DAY / 10);
  imp += 0.2 * Math.log1p((row.bodyText?.length ?? 0) / 80);
  return Math.max(0.3, imp);
}

// Tamaño por defecto en el lienzo antiguo; solo sirve para colocar a los
// hermanos unos respecto a otros.
const NOTE_SIZE = { w: 240, h: 80 };
export const rectOf = (row: NoteRow): Rect => ({ x: row.x, y: row.y, w: row.w ?? NOTE_SIZE.w, h: row.h ?? NOTE_SIZE.h });

// Madre de cada nota; si apunta a algo que no existe (o formaría un ciclo), va a la raíz.
export function parentMap(rows: NoteRow[]): Map<string, string | null> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string | null>();
  for (const row of rows) {
    let p = row.zoneId && row.zoneId !== row.id && byId.has(row.zoneId) ? row.zoneId : null;
    const seen = new Set([row.id]);
    for (let cur = p; cur; cur = byId.get(cur)?.zoneId ?? null) {
      if (seen.has(cur)) {
        p = null;
        break;
      }
      seen.add(cur);
      if (!byId.has(cur)) break;
    }
    out.set(row.id, p);
  }
  return out;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Una ruta escrita «Padre>Hijo»: las notas que existen, desde la raíz, y los
// nombres que faltan. Con dos del mismo nombre, mejor la que ya tiene hijas.
export type Route = { found: NoteRow[]; missing: string[]; zoneId: string | null };
export function resolvePath(rows: NoteRow[], parent: Map<string, string | null>, names: string[]): Route {
  const branches = new Set([...parent.values()].filter(Boolean));
  const found: NoteRow[] = [];
  let at: string | null = null;
  let i = 0;
  for (; i < names.length; i++) {
    const want = fold(names[i]);
    const same = rows.filter((r) => (parent.get(r.id) ?? null) === at && fold(r.title ?? '') === want);
    const z = same.find((r) => branches.has(r.id)) ?? same[0];
    if (!z) break;
    found.push(z);
    at = z.id;
  }
  return { found, missing: names.slice(i), zoneId: at };
}

// La ruta completa de una nota como se escribe: «Viaje a Japón>Qué ver>»
// (con «>» al final si tiene hijas, para seguir escribiendo dentro).
export function pathText(r: NoteRow, byId: Map<string, NoteRow>, parent: Map<string, string | null>, hasKids: boolean) {
  const names: string[] = [];
  for (let z = byId.get(parent.get(r.id) ?? ''); z; z = byId.get(parent.get(z.id) ?? '')) names.unshift(z.title ?? '');
  return names.map((n) => `${n}>`).join('') + (r.title ?? '') + (hasKids ? '>' : '');
}

// «Enter crea «Templos» en Viaje a Japón › Qué ver (nueva)».
export function routeText(route: Route, title: string) {
  const parts = [...route.found.map((z) => z.title || 'Nota sin título'), ...route.missing.map((n) => `${n} (nueva)`)];
  const where = parts.length ? parts.join(' › ') : 'la raíz';
  if (title) return `Enter crea «${title}» en ${where}`;
  if (route.missing.length) return `Enter crea ${where}`;
  return `Enter entra en ${where}`;
}

// Sin las archivadas ni lo que cuelga de ellas.
export function visibleRows(rows: NoteRow[]): NoteRow[] {
  if (!rows.some((r) => r.archivedAt)) return rows;
  const parent = parentMap(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hidden = new Map<string, boolean>();
  const isHidden = (id: string): boolean => {
    const known = hidden.get(id);
    if (known !== undefined) return known;
    const r = byId.get(id);
    const up = parent.get(id);
    const out = !!r?.archivedAt || (!!up && isHidden(up));
    hidden.set(id, out);
    return out;
  };
  return rows.filter((r) => !isHidden(r.id));
}
