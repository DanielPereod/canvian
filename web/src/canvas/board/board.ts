import type { NoteRow } from '../../api';
import { cleanDrawings, type Drawing } from './draw';

// Contenido de una nota de tipo canvas, en el formato de JSON Canvas
// (https://jsoncanvas.org) que usa Obsidian, con un tipo propio: `note`, que
// apunta a otra nota de Canvian por su id, y otro campo: `drawings`, lo
// dibujado a mano encima (ver draw.ts). Se guarda tal cual en bodyJson.

export type BoardNode =
  | { id: string; type: 'text'; x: number; y: number; width: number; height: number; text: string; color?: string }
  | { id: string; type: 'note'; x: number; y: number; width: number; height: number; noteId: string; color?: string }
  | { id: string; type: 'file'; x: number; y: number; width: number; height: number; file: string; name?: string; color?: string }
  | { id: string; type: 'group'; x: number; y: number; width: number; height: number; label?: string; color?: string };

export type BoardEdge = { id: string; fromNode: string; toNode: string; label?: string; toEnd?: 'arrow' | 'none' };

export type Board = { type: 'canvas'; nodes: BoardNode[]; edges: BoardEdge[]; drawings?: Drawing[] };

export const emptyBoard = (): Board => ({ type: 'canvas', nodes: [], edges: [] });

export function parseBoard(bodyJson: string | null): Board {
  if (!bodyJson) return emptyBoard();
  try {
    const v = JSON.parse(bodyJson) as Partial<Board>;
    if (v && v.type === 'canvas' && Array.isArray(v.nodes)) {
      const drawings = cleanDrawings(v.drawings);
      return { type: 'canvas', nodes: v.nodes, edges: Array.isArray(v.edges) ? v.edges : [], ...(drawings.length ? { drawings } : {}) };
    }
  } catch {
    // Un cuerpo roto se abre vacío en vez de romper la hoja.
  }
  return emptyBoard();
}

// Texto buscable del lienzo: lo escrito en sus tarjetas y los nombres de grupos,
// notas enlazadas y archivos, y los textos dibujados encima.
export function boardText(board: Board, rows: Map<string, NoteRow>): string {
  return board.nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'group' ? (n.label ?? '') : n.type === 'note' ? (rows.get(n.noteId)?.title ?? '') : (n.name ?? '')))
    .concat((board.drawings ?? []).map((d) => (d.kind === 'text' ? d.text : '')))
    .filter((t) => t.trim())
    .join('\n');
}

// ── Cambios de otro dispositivo ──────────────────────────────────────

// Une lo que llega de fuera (`remote`) con lo que hay aquí (`local`), cosa a
// cosa. `base` es lo último que llegó de fuera y `known`, todo lo que este
// lienzo sabe que ha estado guardado (lo que llegó y lo que guardó él).
// - Lo que fuera sigue como en `base` no lo ha tocado nadie más: vale lo de aquí.
// - Lo que fuera ha cambiado, se toma de fuera (lo último manda).
// - Lo que aquí falta y ya estuvo guardado, se borró aquí: sigue borrado.
// - Lo que fuera falta y ya estuvo guardado, se borró allí: se quita aquí.
// - Lo nuevo de un lado o del otro, entra.
// Así dos personas moviendo tarjetas distintas a la vez no se pisan, aunque
// una guarde el lienzo entero sin haber visto aún lo de la otra.
function mergeList<T extends { id: string }>(base: T[], local: T[], remote: T[], known: Set<string>): T[] {
  const key = (x: T | undefined) => (x ? JSON.stringify(x) : '');
  const b = new Map(base.map((x) => [x.id, x]));
  const l = new Map(local.map((x) => [x.id, x]));
  const r = new Set(remote.map((x) => x.id));
  const out: T[] = [];
  for (const x of remote) {
    const mine = l.get(x.id);
    if (mine) out.push(key(x) === key(b.get(x.id)) ? mine : x);
    else if (!known.has(x.id)) out.push(x);
  }
  for (const x of local) if (!r.has(x.id) && !known.has(x.id)) out.push(x);
  return out;
}

export function mergeBoards(base: Board, local: Board, remote: Board, known: Set<string>): Board {
  const nodes = mergeList(base.nodes, local.nodes, remote.nodes, known);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = mergeList(base.edges, local.edges, remote.edges, known).filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
  const drawings = mergeList(base.drawings ?? [], local.drawings ?? [], remote.drawings ?? [], known);
  return { type: 'canvas', nodes, edges, ...(drawings.length ? { drawings } : {}) };
}

// Los ids de todo lo que hay en un lienzo (tarjetas, flechas y dibujos).
export const boardIds = (b: Board) => [...b.nodes, ...b.edges, ...(b.drawings ?? [])].map((x) => x.id);

// ── Grupos ───────────────────────────────────────────────────────────

export type Rect = { x: number; y: number; w: number; h: number };

// Lo que cae entero dentro de un grupo es suyo (como en Obsidian): se mueve con él.
export const inside = (r: Rect, g: Rect) => r.x >= g.x - 1 && r.y >= g.y - 1 && r.x + r.w <= g.x + g.w + 1 && r.y + r.h <= g.y + g.h + 1;

// El recuadro de un grupo nuevo alrededor de lo elegido, con margen y sitio
// arriba para su nombre.
export function groupAround(rects: Rect[], pad = 32, top = 56): Rect {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: Math.round(x1 - pad), y: Math.round(y1 - top), w: Math.round(x2 - x1 + pad * 2), h: Math.round(y2 - y1 + top + pad) };
}
