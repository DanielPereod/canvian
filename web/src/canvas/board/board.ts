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
