import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteRow } from '../api';
import type { JSONContent } from '@tiptap/react';
import { bodyToHtml, parseBody, splitTitle } from './editor';
import { withoutMarks } from './tasks';

// Sin la sintaxis de las tareas (📅, ⏫…), como en el resto de resúmenes.
const clean = (n: JSONContent): JSONContent => (n.type === 'text' && n.text ? { ...n, text: withoutMarks(n.text) || ' ' } : n.content ? { ...n, content: n.content.map(clean) } : n);

// Vista previa de una nota al dejar el ratón encima de su fila, como al pasar
// por un enlace en Obsidian: el principio de su texto, sin abrirla.

const DELAY = 650;
const canHover = () => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

export function useNotePeek() {
  const [peek, setPeek] = useState<{ row: NoteRow; rect: DOMRect } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = () => {
    window.clearTimeout(timer.current);
    setPeek(null);
  };
  const props = (row: NoteRow) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (!canHover() || row.kind === 'canvas' || !row.bodyText?.trim()) return;
      const el = e.currentTarget;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPeek({ row, rect: el.getBoundingClientRect() }), DELAY);
    },
    onMouseLeave: hide,
    onMouseDown: hide,
  });
  const node = peek ? <Peek row={peek.row} rect={peek.rect} /> : null;
  return { props, node, hide };
}

/** El texto de la nota en HTML, sin el título ni la sintaxis de las tareas. */
export const notePreviewHtml = (row: NoteRow) => bodyToHtml(JSON.stringify(clean(splitTitle(parseBody(row.bodyJson)).body)));

function Peek({ row, rect }: { row: NoteRow; rect: DOMRect }) {
  const html = notePreviewHtml(row);
  if (!html) return null;
  const W = 420;
  const H = 300;
  const left = Math.min(rect.left + 52, window.innerWidth - W - 16);
  const below = rect.bottom + 6 + H < window.innerHeight;
  const style = { left, width: W, ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) };
  return createPortal(
    <div className="note-peek" style={style} aria-hidden="true">
      <div className="prose note-peek-in" dangerouslySetInnerHTML={{ __html: html }} />
    </div>,
    document.body,
  );
}
