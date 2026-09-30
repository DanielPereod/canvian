import type { NoteInput, NoteRow } from '../../api';

// Contenido de una nota de tipo canvas, en el formato de JSON Canvas
// (https://jsoncanvas.org) que usa Obsidian, con un tipo propio: `note`, que
// apunta a otra nota de Canvian por su id. Se guarda tal cual en bodyJson.

export type BoardNode =
  | { id: string; type: 'text'; x: number; y: number; width: number; height: number; text: string; color?: string }
  | { id: string; type: 'note'; x: number; y: number; width: number; height: number; noteId: string; color?: string }
  | { id: string; type: 'file'; x: number; y: number; width: number; height: number; file: string; color?: string }
  | { id: string; type: 'group'; x: number; y: number; width: number; height: number; label?: string; color?: string };

export type BoardEdge = { id: string; fromNode: string; toNode: string; label?: string; toEnd?: 'arrow' | 'none' };

export type Board = { type: 'canvas'; nodes: BoardNode[]; edges: BoardEdge[] };

export const emptyBoard = (): Board => ({ type: 'canvas', nodes: [], edges: [] });

export function parseBoard(bodyJson: string | null): Board {
  if (!bodyJson) return emptyBoard();
  try {
    const v = JSON.parse(bodyJson) as Partial<Board>;
    if (v && v.type === 'canvas' && Array.isArray(v.nodes)) return { type: 'canvas', nodes: v.nodes, edges: Array.isArray(v.edges) ? v.edges : [] };
  } catch {
    // Un cuerpo roto se abre vacío en vez de romper la hoja.
  }
  return emptyBoard();
}

// Texto buscable del lienzo: lo escrito en sus tarjetas y los nombres de grupos
// y notas enlazadas.
export function boardText(board: Board, rows: Map<string, NoteRow>): string {
  return board.nodes
    .map((n) => (n.type === 'text' ? n.text : n.type === 'group' ? (n.label ?? '') : n.type === 'note' ? (rows.get(n.noteId)?.title ?? '') : ''))
    .filter((t) => t.trim())
    .join('\n');
}

// Una nota de texto pasa a canvas con su texto como primera tarjeta.
export function boardFromText(text: string | null): Board {
  const b = emptyBoard();
  if (text?.trim()) b.nodes.push({ id: 'n' + Date.now().toString(36), type: 'text', x: -160, y: -60, width: 320, height: 160, text: text.trim() });
  return b;
}

// Cambio de tipo de una nota. El cuerpo se convierte cuando se entra o se sale
// de canvas: el texto pasa a una tarjeta, y el título y el texto de las
// tarjetas, a párrafos.
export function kindChange(row: NoteRow, kind: 'text' | 'canvas'): NoteInput {
  if (row.kind === kind) return {};
  // La primera línea de una nota es su título, que el canvas guarda aparte.
  if (kind === 'canvas') {
    const text = (row.bodyText ?? '').split('\n').slice(1).join('\n').trim();
    return { kind, bodyJson: JSON.stringify(boardFromText(text)), bodyText: text || null };
  }
  if (row.kind !== 'canvas') return { kind };
  const lines = [row.title ?? '', ...(row.bodyText ?? '').split('\n')].filter((l) => l.trim());
  const doc = { type: 'doc', content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
  return { kind, bodyJson: lines.length ? JSON.stringify(doc) : null, bodyText: lines.join('\n') || null };
}
