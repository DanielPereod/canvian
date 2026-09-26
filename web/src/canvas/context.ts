import { createContext, useContext } from 'react';
import type { NoteInput, NoteRow, PropertyDef } from '../api';

export type NoteContent = { bodyJson: string; bodyText: string; title: string | null };

export type CanvasActions = {
  editingId: string | null;
  startEditing: (id: string) => void;
  finishEditing: (id: string) => void;
  saveContent: (id: string, content: NoteContent) => void;
  renameZone: (id: string, title: string) => void;
  resized: (id: string, rect: { x: number; y: number; width: number; height: number }) => void;
  cycleStatus: (id: string) => void;
  // Notas que alumbra la linterna; null cuando no hay filtro.
  lit: Set<string> | null;
  defs: PropertyDef[];
  updateNote: (id: string, change: NoteInput) => void;
  openInspector: (id: string) => void;
};

export const CanvasContext = createContext<CanvasActions | null>(null);

export function useCanvasActions(): CanvasActions {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvasActions fuera del canvas');
  return ctx;
}

export type NoteData = NoteRow & Record<string, unknown>;
