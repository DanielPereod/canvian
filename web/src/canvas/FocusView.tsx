import { useEffect, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { NoteRow, PropertyDef } from '../api';
import { extensions, parseBody, titleFrom } from './editor';
import type { NoteContent } from './context';
import { NoteChips } from './NoteChips';
import { TaskGlyph } from './TaskGlyph';
import { useExperiments } from '../lab/experiments';

const MAX_NEIGHBORS = 12;

type Props = {
  note: NoteRow;
  neighbors: NoteRow[];
  defs: PropertyDef[];
  onNavigate: (id: string) => void;
  onSave: (id: string, content: NoteContent) => void;
  onCycle: (id: string) => void;
  onProps: (id: string) => void;
  onClose: () => void;
};

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

function FocusEditor({ note, onSave }: { note: NoteRow; onSave: Props['onSave'] }) {
  const editor = useEditor({
    extensions,
    content: parseBody(note.bodyJson) ?? '',
    // Entrar en el foco es para escribir: el cursor ya está al final.
    autofocus: 'end',
    editorProps: { attributes: { class: 'note-body prose focus-prose' } },
    onUpdate: ({ editor }) => {
      const bodyText = editor.getText({ blockSeparator: '\n' });
      onSave(note.id, { bodyJson: JSON.stringify(editor.getJSON()), bodyText, title: titleFrom(bodyText) });
    },
  });
  return <EditorContent editor={editor} className="focus-editor" />;
}

// Modo foco (Enter): la nota crece en el centro y sus vecinas la rodean.
// Pulsar una vecina la trae al centro, así se recorre el grafo sin perderse.
export function FocusView({ note, neighbors, defs, onNavigate, onSave, onCycle, onProps, onClose }: Props) {
  const { maduran } = useExperiments();
  const { w, h } = useViewport();
  const [leaving, setLeaving] = useState(false);
  const shown = neighbors.slice(0, MAX_NEIGHBORS);
  const narrow = w < 820;

  const close = () => {
    setLeaving(true);
    setTimeout(onClose, 200);
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

  // Vecinas en una elipse alrededor del centro, empezando arriba.
  const rx = Math.max(260, w / 2 - 150);
  const ry = Math.max(200, h / 2 - 90);
  const spots = shown.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(shown.length, 1);
    return { x: w / 2 + rx * Math.cos(a), y: h / 2 + ry * Math.sin(a) };
  });

  return (
    <div className={`focus${leaving ? ' is-leaving' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      {!narrow && (
        <svg className="focus-stems" width={w} height={h} aria-hidden="true">
          {spots.map((s, i) => (
            <path
              key={shown[i].id}
              d={`M ${w / 2} ${h / 2} Q ${(w / 2 + s.x) / 2} ${h / 2} ${s.x} ${s.y}`}
              pathLength={1}
              style={{ '--i': i } as CSSProperties}
            />
          ))}
        </svg>
      )}

      <article className="focus-card surface-2" key={note.id}>
        {note.kind === 'task' && <TaskGlyph status={note.status ?? 'todo'} ripe={maduran} onCycle={() => onCycle(note.id)} />}
        <FocusEditor note={note} onSave={onSave} />
        <NoteChips note={note} defs={defs} onOpen={() => onProps(note.id)} />
        <footer className="focus-foot meta">
          {neighbors.length ? `${neighbors.length} ${neighbors.length === 1 ? 'enlace' : 'enlaces'}` : 'Sin enlaces'} · Esc para volver
        </footer>
      </article>

      <div className={narrow ? 'focus-list' : 'focus-ring'}>
        {shown.map((n, i) => (
          <button
            key={n.id}
            className="focus-neighbor surface-1"
            style={(narrow ? { '--i': i } : { '--i': i, left: spots[i].x, top: spots[i].y }) as unknown as CSSProperties}
            onClick={() => onNavigate(n.id)}
          >
            <span className="focus-neighbor-title">{n.title || 'Nota sin título'}</span>
            {n.bodyText && n.bodyText.trim() !== (n.title ?? '').trim() && (
              <span className="focus-neighbor-body">{n.bodyText.split('\n').slice(1).join(' ').slice(0, 90)}</span>
            )}
          </button>
        ))}
        {neighbors.length > MAX_NEIGHBORS && <span className="focus-more meta">+{neighbors.length - MAX_NEIGHBORS} más</span>}
      </div>
    </div>
  );
}
