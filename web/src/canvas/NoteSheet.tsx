import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { NoteRow, PropertyDef } from '../api';
import type { OpenFrom } from './fluid';
import { extensions, parseBody, titleFrom } from './editor';
import { NoteChips } from './NoteChips';
import { TaskGlyph } from './TaskGlyph';
import { useExperiments } from '../lab/experiments';
import { MediaUpload } from './media';
import { SectionPicker, type SectionOption } from './SectionPicker';

// En el mapa de secciones una nota se abre como hoja a pantalla completa: la
// celda termina de crecer hasta los bordes con su mismo tinte, y al cerrar
// vuelve a encogerse hasta ella.

const OPEN_MS = 620;
const CLOSE_MS = 420;
const MAX_LINKS = 24;

export type NoteContent = { bodyJson: string; bodyText: string; title: string | null };

function SheetEditor({ note, onSave, onError }: { note: NoteRow; onSave: (id: string, content: NoteContent) => void; onError: (e: unknown) => void }) {
  const editor = useEditor({
    extensions: [...extensions, MediaUpload.configure({ onError })],
    content: parseBody(note.bodyJson) ?? '',
    // Abrir una nota es para escribir: el cursor ya está al final.
    autofocus: 'end',
    editorProps: { attributes: { class: 'note-body prose sheet-prose' } },
    onUpdate: ({ editor }) => {
      const bodyText = editor.getText({ blockSeparator: '\n' });
      onSave(note.id, { bodyJson: JSON.stringify(editor.getJSON()), bodyText, title: titleFrom(bodyText) });
    },
  });
  return <EditorContent editor={editor} className="sheet-editor" />;
}

type Props = {
  note: NoteRow;
  neighbors: NoteRow[];
  defs: PropertyDef[];
  from: OpenFrom | null;
  onNavigate: (id: string) => void;
  onSave: (id: string, content: NoteContent) => void;
  onCycle: (id: string) => void;
  onProps: (id: string) => void;
  onTask: () => void;
  onBlock: () => void;
  onLink: () => void;
  onUnlink: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
  // Secciones a las que se puede mover y la ruta de la actual.
  sections: SectionOption[];
  onMove: (zoneId: string | null) => void;
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

export function NoteSheet({ note, neighbors, defs, from, onNavigate, onSave, onCycle, onProps, onTask, onBlock, onLink, onUnlink, onDelete, onClose, onError, sections, onMove }: Props) {
  const { maduran } = useExperiments();
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const [moving, setMoving] = useState(false);
  const where = sections.find((o) => o.id === note.zoneId)?.path ?? null;
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

  const close = (then: () => void = onClose) => {
    const el = ref.current;
    if (!el || leaving.current) return;
    leaving.current = true;
    el.classList.add('is-leaving');
    const a = el.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }, { clipPath: insetOf(el, from), opacity: from ? 1 : 0 }], {
      duration: CLOSE_MS,
      easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
      fill: 'forwards',
    });
    a.onfinish = then;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Con el inspector o el buscador abiertos, Esc los cierra a ellos y no a la hoja.
      if (e.key === 'Escape' && !document.querySelector('.inspector, .overlay')) {
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
        <button className="sheet-back" onClick={() => close()}>
          ← Volver
        </button>
        <span className="sheet-actions">
          <button className="sheet-back" onClick={onTask}>
            {note.kind === 'task' ? 'Quitar tarea' : 'Hacer tarea'}
          </button>
          {note.kind === 'task' && (
            <button className="sheet-back" onClick={onBlock}>
              {note.status === 'blocked' ? 'Desbloquear' : 'Bloquear'}
            </button>
          )}
          <button className="sheet-back" onClick={() => onProps(note.id)}>
            Propiedades
          </button>
          <button className="sheet-back danger" onClick={() => close(() => onDelete(note.id))}>
            Borrar
          </button>
        </span>
      </header>
      <article className="sheet-body" key={note.id}>
        <button className="sheet-where meta" onClick={() => setMoving(true)} title="Mover a otra sección">
          {where ? where.split(' › ').map((p, i) => (
            <span key={i}>
              {i > 0 && <span className="sheet-where-sep">›</span>}
              {p}
            </span>
          )) : <span>Sin sección</span>}
          <span className="sheet-where-move">Mover</span>
        </button>
        {note.kind === 'task' && <TaskGlyph status={note.status ?? 'todo'} ripe={maduran} onCycle={() => onCycle(note.id)} />}
        <SheetEditor note={note} onSave={onSave} onError={onError} />
        <NoteChips note={note} defs={defs} onOpen={() => onProps(note.id)} />
        <nav className="sheet-links">
          <span className="meta">{neighbors.length === 0 ? 'Sin enlaces' : neighbors.length === 1 ? '1 enlace' : `${neighbors.length} enlaces`}</span>
          {shown.map((n, i) => (
            <span key={n.id} className="sheet-link" style={{ '--i': i } as CSSProperties}>
              <button className="sheet-link-go" onClick={() => onNavigate(n.id)}>
                {n.title || 'Nota sin título'}
              </button>
              <button className="sheet-link-x" onClick={() => onUnlink(n.id)} aria-label={`Quitar el enlace con ${n.title || 'esta nota'}`} title="Quitar enlace">
                ×
              </button>
            </span>
          ))}
          {neighbors.length > MAX_LINKS && <span className="meta">+{neighbors.length - MAX_LINKS} más</span>}
          <button className="sheet-link sheet-link-add" style={{ '--i': shown.length } as CSSProperties} onClick={onLink}>
            + Enlazar
          </button>
        </nav>
      </article>
      {moving && (
        <SectionPicker
          options={sections}
          current={note.zoneId}
          onPick={(zoneId) => {
            setMoving(false);
            onMove(zoneId);
          }}
          onClose={() => setMoving(false)}
        />
      )}
    </div>
  );
}
