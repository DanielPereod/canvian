import type { NoteRow } from '../api';
import { daysUntil } from './dates';

// Mapa de secciones: todo el lienzo como un árbol. Las zonas son secciones,
// una zona dibujada dentro de otra es su subsección y las notas son las hojas.
// Cada nodo lleva una importancia que decide cuánto espacio ocupa.

export type Rect = { x: number; y: number; w: number; h: number };
export type MapNode = {
  id: string;
  kind: 'root' | 'zone' | 'group' | 'note';
  title: string;
  // Dónde está en el lienzo: sirve para conservar la disposición.
  rect: Rect;
  importance: number;
  children: MapNode[];
  // Notas que hay dentro, contando las de las subsecciones.
  count: number;
  // Zona en la que se crean las notas nuevas desde este nivel.
  zoneId: string | null;
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
const ZONE_SIZE = { w: 480, h: 320 };
export const rectOf = (row: NoteRow): Rect => {
  const d = row.kind === 'zone' ? ZONE_SIZE : NOTE_SIZE;
  return { x: row.x, y: row.y, w: row.w ?? d.w, h: row.h ?? d.h };
};

type Input = { row: NoteRow; rect: Rect };

// El árbol sale de los datos: `zoneId` es la sección madre de cada nota o
// sección. Si apunta a algo que no existe (o formaría un ciclo), va a la raíz.
export function buildTree(rows: NoteRow[], links: { source: string; target: string }[]): MapNode {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const zoneIds = new Set(rows.filter((r) => r.kind === 'zone').map((r) => r.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parentOf = (row: NoteRow) => {
    const p = row.zoneId;
    if (!p || p === row.id || !zoneIds.has(p)) return null;
    // Un ciclo (A dentro de B dentro de A) se corta en la raíz.
    const seen = new Set([row.id]);
    for (let cur: string | null = p; cur; cur = byId.get(cur)?.zoneId ?? null) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      if (!zoneIds.has(cur)) break;
    }
    return p;
  };
  const zoneKids = new Map<string | null, Input[]>();
  const noteKids = new Map<string | null, Input[]>();
  for (const row of rows) {
    const map = row.kind === 'zone' ? zoneKids : noteKids;
    const p = parentOf(row);
    map.set(p, [...(map.get(p) ?? []), { row, rect: rectOf(row) }]);
  }

  const noteNode = (it: Input): MapNode => ({
    id: it.row.id,
    kind: 'note',
    title: it.row.title || 'Nota sin título',
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

  const zoneNode = (z: Input): MapNode => {
    const subs = (zoneKids.get(z.row.id) ?? []).map(zoneNode);
    const notes = (noteKids.get(z.row.id) ?? []).map(noteNode);
    const children = [...subs, ...group(notes, z.row.id, z.row.id, Math.max(4, MAX_PER_LEVEL - subs.length))];
    return {
      id: z.row.id,
      kind: 'zone',
      title: z.row.title || 'Sin nombre',
      rect: z.rect,
      importance: sectionImportance(children),
      children,
      count: children.reduce((t, c) => t + c.count, 0),
      zoneId: z.row.id,
    };
  };

  const tops = (zoneKids.get(null) ?? []).map(zoneNode);
  const loose = (noteKids.get(null) ?? []).map(noteNode);
  let children: MapNode[];
  if (!tops.length) children = group(loose, null, 'root', MAX_PER_LEVEL);
  else if (!loose.length) children = tops;
  else {
    const inner = group(loose, null, 'loose', MAX_PER_LEVEL);
    children = [
      ...tops,
      {
        id: 'loose',
        kind: 'group',
        title: 'Sin sección',
        rect: bounds(loose.map((n) => n.rect)),
        importance: sectionImportance(inner),
        children: inner,
        count: loose.length,
        zoneId: null,
      },
    ];
  }
  return {
    id: 'root',
    kind: 'root',
    title: 'Todo',
    rect: bounds(children.map((c) => c.rect)),
    importance: 1,
    children,
    count: children.reduce((t, c) => t + c.count, 0),
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
