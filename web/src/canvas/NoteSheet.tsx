import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { NoteRow, PropertyDef } from '../api';
import type { NoteContent } from './context';
import type { OpenFrom } from './fluid';
import { FocusEditor } from './FocusView';
import { NoteChips } from './NoteChips';
import { TaskGlyph } from './TaskGlyph';
import { useExperiments } from '../lab/experiments';

// En el mapa de secciones una nota se abre como hoja a pantalla completa: la
// celda termina de crecer hasta los bordes con su mismo tinte, y al cerrar
// vuelve a encogerse hasta ella.

const OPEN_MS = 620;
const CLOSE_MS = 420;
const MAX_LINKS = 12;

type Props = {
  note: NoteRow;
  neighbors: NoteRow[];
  defs: PropertyDef[];
  from: OpenFrom | null;
  onNavigate: (id: string) => void;
  onSave: (id: string, content: NoteContent) => void;
  onCycle: (id: string) => void;
  onProps: (id: string) => void;
  onClose: () => void;
};

// Recorte con la forma de la celda, relativo a la hoja.
function insetOf(sheet: HTMLElement, from: OpenFrom | null) {
  const b = sheet.getBoundingClientRect();
  if (!from) {
    const x = b.width * 0.3;
    const y = b.height * 0.3;
    return `inset(${y}px ${x}px ${y}px ${x}px round 48px)`;
  }
  const host = sheet.parentElement!.getBoundingClientRect();
  const left = Math.max(0, from.rect.x + host.left - b.left);
  const top = Math.max(0, from.rect.y + host.top - b.top);
  const right = Math.max(0, b.width - left - from.rect.w);
  const bottom = Math.max(0, b.height - top - from.rect.h);
  return `inset(${top}px ${right}px ${bottom}px ${left}px round 48px)`;
}

export function NoteSheet({ note, neighbors, defs, from, onNavigate, onSave, onCycle, onProps, onClose }: Props) {
  const { maduran } = useExperiments();
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const shown = neighbors.slice(0, MAX_LINKS);
  const hue = from?.hue;

  useLayoutEffect(() => {
    const el = ref.current!;
    el.animate([{ clipPath: insetOf(el, from), opacity: from ? 1 : 0 }, { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }], {
      duration: OPEN_MS,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
    // Solo al abrir: navegar entre notas cambia el contenido, no la hoja.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    const el = ref.current;
    if (!el || leaving.current) return;
    leaving.current = true;
    el.classList.add('is-leaving');
    const a = el.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }, { clipPath: insetOf(el, from), opacity: from ? 1 : 0 }], {
      duration: CLOSE_MS,
      easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
      fill: 'forwards',
    });
    a.onfinish = onClose;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div ref={ref} className="sheet" style={(hue !== undefined ? { '--hue': hue } : {}) as CSSProperties}>
      <header className="sheet-top meta">
        <button className="sheet-back" onClick={close}>
          ← Volver
        </button>
        <span>Esc para volver</span>
      </header>
      <article className="sheet-body" key={note.id}>
        {note.kind === 'task' && <TaskGlyph status={note.status ?? 'todo'} ripe={maduran} onCycle={() => onCycle(note.id)} />}
        <FocusEditor note={note} onSave={onSave} />
        <NoteChips note={note} defs={defs} onOpen={() => onProps(note.id)} />
        {shown.length > 0 && (
          <nav className="sheet-links">
            <span className="meta">{neighbors.length === 1 ? '1 enlace' : `${neighbors.length} enlaces`}</span>
            {shown.map((n, i) => (
              <button key={n.id} className="sheet-link" style={{ '--i': i } as CSSProperties} onClick={() => onNavigate(n.id)}>
                {n.title || 'Nota sin título'}
              </button>
            ))}
            {neighbors.length > MAX_LINKS && <span className="meta">+{neighbors.length - MAX_LINKS} más</span>}
          </nav>
        )}
      </article>
    </div>
  );
}
