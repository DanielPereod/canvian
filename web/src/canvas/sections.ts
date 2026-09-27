import type { NoteRow } from '../api';
import { daysUntil } from './dates';

// Mapa de secciones: todas las notas como un árbol. Cualquier nota puede ser
// madre de otras (`zoneId` es su madre); una nota con hijas se ve como una
// sección en la que se entra, y las que no tienen hijas son las hojas. Cada
// nodo lleva una importancia que decide cuánto espacio ocupa.

export type Rect = { x: number; y: number; w: number; h: number };
export type MapNode = {
  id: string;
  // zone: una nota con hijas (se entra en ella); note: una hoja (se abre).
  kind: 'root' | 'zone' | 'group' | 'note';
  title: string;
  // Dónde está en el lienzo: sirve para conservar la disposición.
  rect: Rect;
  importance: number;
  children: MapNode[];
  // Notas que hay dentro, contando las de las subsecciones.
  count: number;
  // Nota madre de las notas nuevas creadas desde este nivel.
  zoneId: string | null;
  // La nota que representa (en una sección, la propia nota madre).
  note?: NoteRow;
};

// Más de esto en un nivel no se lee: las notas se agrupan por cercanía.
const MAX_PER_LEVEL = 40;
const DAY = 86_400_000;

export const bounds = (rs: Rect[]): Rect => {
  if (!rs.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x || 1, h: Math.max(...rs.map((r) => r.y + r.h)) - y || 1 };
};

// Importancia de una nota: enlaces, prioridad, si está en curso o vencida, si
// la tocaste hace poco y cuánto texto tiene. Lo hecho pesa menos.
export function importanceOf(row: NoteRow, degree: number, now = Date.now()) {
  let imp = 1 + 0.55 * Math.min(degree, 8) + 0.5 * (row.priority ?? 0);
  if (row.kind === 'task') {
    if (row.status === 'doing') imp += 0.8;
    if (row.status === 'done') imp *= 0.55;
    if (row.status === 'blocked') imp *= 0.8;
    if (row.status !== 'done' && row.dueAt && daysUntil(row.dueAt) <= 2) imp += 1;
  }
  if (row.updatedAt) imp += 1.5 * Math.exp(-(now - Date.parse(row.updatedAt)) / DAY / 10);
  imp += 0.2 * Math.log1p((row.bodyText?.length ?? 0) / 80);
  return Math.max(0.3, imp);
}

// Tamaño por defecto en el lienzo antiguo; solo sirve para colocar a los
// hermanos unos respecto a otros.
const NOTE_SIZE = { w: 240, h: 80 };
export const rectOf = (row: NoteRow): Rect => ({ x: row.x, y: row.y, w: row.w ?? NOTE_SIZE.w, h: row.h ?? NOTE_SIZE.h });

// Id de la celda con la que se abre una nota madre desde dentro de su sección.
export const SELF = 'self:';
export const noteIdOf = (n: MapNode) => n.note?.id ?? n.id;

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

// Notas que tienen alguna hija.
export function parentsOf(rows: NoteRow[]): Set<string> {
  const out = new Set<string>();
  for (const p of parentMap(rows).values()) if (p) out.add(p);
  return out;
}

type Input = { row: NoteRow; rect: Rect };

// El árbol sale de los datos: `zoneId` es la sección madre de cada nota o
// sección. Si apunta a algo que no existe (o formaría un ciclo), va a la raíz.
export function buildTree(rows: NoteRow[], links: { source: string; target: string }[]): MapNode {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const parent = parentMap(rows);
  const kids = new Map<string | null, Input[]>();
  for (const row of rows) {
    const p = parent.get(row.id) ?? null;
    kids.set(p, [...(kids.get(p) ?? []), { row, rect: rectOf(row) }]);
  }
  const hasKids = (id: string) => (kids.get(id)?.length ?? 0) > 0;

  const noteNode = (it: Input): MapNode => ({
    id: it.row.id,
    kind: 'note',
    title: it.row.title || (it.row.kind === 'task' ? 'Tarea sin título' : 'Nota sin título'),
    rect: it.rect,
    importance: importanceOf(it.row, degree.get(it.row.id) ?? 0),
    children: [],
    count: 1,
    zoneId: it.row.zoneId,
    note: it.row,
  });

  // Muchas notas en un nivel no se leen, así que se agrupan por algo con
  // sentido (la posición en el lienzo antiguo ya no lo tiene):
  // - si sobran pocas, se ven las más importantes y el resto va a «Otras N»;
  // - si sobran muchas, por cuándo se tocaron («Esta semana», «agosto»…);
  // - si todas son de la misma época, por orden alfabético («A – F»).
  const makeGroup = (id: string, title: string, chunk: MapNode[], zoneId: string | null): MapNode => {
    const children = group(chunk, zoneId, id, MAX_PER_LEVEL);
    return { id: `group:${id}`, kind: 'group', title, rect: bounds(chunk.map((n) => n.rect)), importance: sectionImportance(children), children, count: chunk.length, zoneId };
  };
  const group = (notes: MapNode[], zoneId: string | null, key: string, room: number): MapNode[] => {
    if (notes.length <= room) return notes;
    const byImportance = [...notes].sort((a, b) => b.importance - a.importance);
    if (notes.length <= room * 2) {
      const rest = byImportance.slice(room - 1);
      return [...byImportance.slice(0, room - 1), makeGroup(`${key}.otras`, `Otras ${rest.length} notas`, rest, zoneId)];
    }
    const buckets = new Map<string, { order: number; title: string; items: MapNode[] }>();
    for (const n of notes) {
      const [order, title] = whenBucket(n.note?.updatedAt ?? null);
      const b = buckets.get(title) ?? { order, title, items: [] };
      b.items.push(n);
      buckets.set(title, b);
    }
    let list = [...buckets.values()].sort((a, b) => a.order - b.order);
    if (list.length > room) {
      const old = list.slice(room - 1);
      list = [...list.slice(0, room - 1), { order: 1e6, title: 'Antes', items: old.flatMap((b) => b.items) }];
    }
    if (list.length > 1) return list.map((b) => makeGroup(`${key}.${b.title}`, b.title, b.items, zoneId));
    // Todas de la misma época: por orden alfabético, en tramos iguales.
    const byName = [...notes].sort((a, b) => a.title.localeCompare(b.title, 'es'));
    const k = Math.min(room, Math.ceil(notes.length / MAX_PER_LEVEL));
    const per = Math.ceil(byName.length / k);
    const initial = (n: MapNode) => (n.title.trim()[0] ?? '·').toLocaleUpperCase('es');
    const out: MapNode[] = [];
    for (let i = 0; i < byName.length; i += per) {
      const chunk = byName.slice(i, i + per);
      const a = initial(chunk[0]);
      const z = initial(chunk[chunk.length - 1]);
      out.push(makeGroup(`${key}.abc${i}`, a === z ? a : `${a} – ${z}`, chunk, zoneId));
    }
    return out;
  };

  // Una nota con hijas: dentro, sus subsecciones, sus hojas y, si tiene
  // algo escrito además del título, una celda para abrirla a ella.
  const zoneNode = (z: Input): MapNode => {
    const inside = kids.get(z.row.id) ?? [];
    const subs = inside.filter((it) => hasKids(it.row.id)).map(zoneNode);
    const notes = inside.filter((it) => !hasKids(it.row.id)).map(noteNode);
    const own = (z.row.bodyText ?? '').trim();
    if (own && own !== (z.row.title ?? '').trim()) notes.unshift({ ...noteNode(z), id: SELF + z.row.id });
    const children = [...subs, ...group(notes, z.row.id, z.row.id, Math.max(4, MAX_PER_LEVEL - subs.length))];
    return {
      id: z.row.id,
      kind: 'zone',
      title: z.row.title || 'Nota sin título',
      rect: z.rect,
      importance: sectionImportance(children),
      children,
      // Todo lo que cuelga de ella, a cualquier profundidad.
      count: inside.length + subs.reduce((t, c) => t + c.count, 0),
      zoneId: z.row.id,
      note: z.row,
    };
  };

  const top = kids.get(null) ?? [];
  const tops = top.filter((it) => hasKids(it.row.id)).map(zoneNode);
  const loose = top.filter((it) => !hasKids(it.row.id)).map(noteNode);
  // Arriba, muchas notas sueltas taparían las ramas: van juntas en «Sueltas».
  let children: MapNode[];
  if (!tops.length || loose.length <= 6) children = [...tops, ...group(loose, null, 'root', Math.max(4, MAX_PER_LEVEL - tops.length))];
  else {
    const inner = group(loose, null, 'loose', MAX_PER_LEVEL);
    children = [
      ...tops,
      { id: 'loose', kind: 'group', title: 'Sueltas', rect: bounds(loose.map((n) => n.rect)), importance: sectionImportance(inner), children: inner, count: loose.length, zoneId: null },
    ];
  }
  return {
    id: 'root',
    kind: 'root',
    title: 'Todo',
    rect: bounds(children.map((c) => c.rect)),
    importance: 1,
    children,
    count: rows.length,
    zoneId: null,
  };
}

// Época de una nota por su último cambio, para agrupar: [orden, nombre].
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function whenBucket(updatedAt: string | null, now = new Date()): [number, string] {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isNaN(t)) return [1e5, 'Sin fecha'];
  const days = (now.getTime() - t) / DAY;
  if (days < 7) return [0, 'Esta semana'];
  if (days < 31) return [1, 'Este mes'];
  const d = new Date(t);
  const monthsAgo = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (monthsAgo < 12) return [2 + monthsAgo, d.getFullYear() === now.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`];
  return [100 + now.getFullYear() - d.getFullYear(), String(d.getFullYear())];
}

// Una sección pesa lo que sus notas, pero sin crecer sin control.
function sectionImportance(children: MapNode[]) {
  return Math.pow(children.reduce((t, c) => t + c.importance, 0), 0.8) + 1;
}

export function findPath(root: MapNode, id: string): MapNode[] | null {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const sub = findPath(c, id);
    if (sub) return [root, ...sub];
  }
  return null;
}
