import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { NoteRow, PropertyDef } from '../api';
import type { OpenFrom } from './fluid';
import { applyRemote, editingExtensions, extensions, parseBody, titleFrom } from './editor';
import { repairTables } from './markdown';
import { NoteChips } from './NoteChips';
import { TaskGlyph } from './TaskGlyph';
import { useExperiments } from '../lab/experiments';
import { MediaUpload } from './media';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { CanvasBoard } from './board/CanvasBoard';
import { BackArrow } from '../BackArrow';
import { parentMap } from './sections';

// En el mapa de secciones una nota se abre como hoja a pantalla completa: la
// celda termina de crecer hasta los bordes con su mismo tinte, y al cerrar
// vuelve a encogerse hasta ella.

const OPEN_MS = 620;
const CLOSE_MS = 420;
const MAX_LINKS = 24;

export type NoteContent = { bodyJson: string; bodyText: string; title: string | null };

type EditorProps = { note: NoteRow; onSave: (id: string, content: NoteContent) => void; onError: (e: unknown) => void; editorRef: { current: Editor | null } };

function SheetEditor({ note, onSave, onError, editorRef }: EditorProps) {
  // Tablas de Markdown que quedaron como texto con barras: se abren ya como tablas.
  const [initial] = useState(() => {
    const doc = parseBody(note.bodyJson);
    return { doc: repairTables(doc) ?? doc, repaired: !!repairTables(doc) };
  });
  const editor = useEditor({
    extensions: [...extensions, ...editingExtensions, MediaUpload.configure({ onError })],
    content: initial.doc ?? '',
    // Abrir una nota es para escribir: el cursor ya está al final, pero la
    // nota se ve desde el principio (sin saltar hasta el cursor).
    onCreate: ({ editor }) => {
      editor.commands.focus('end', { scrollIntoView: false });
    },
    editorProps: {
      attributes: { class: 'note-body prose sheet-prose' },
      // Ctrl/⌘ clic (o clic central) abre el enlace en otra pestaña.
      handleClick: (_view, _pos, e) => openLink(e),
      handleDOMEvents: {
        auxclick: (_view, e) => e.button === 1 && openLink(e, true),
        // Pulsar dentro de un texto ya seleccionado empieza una selección nueva,
        // como en un editor de texto, en vez de arrastrar lo seleccionado.
        mousedown: (_view, e) => {
          const sel = window.getSelection();
          if (e.button === 0 && !e.shiftKey && !(e.target as HTMLElement).closest('img, video, [data-drag-handle]') && sel && !sel.isCollapsed) sel.removeAllRanges();
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => {
      const bodyText = editor.getText({ blockSeparator: '\n' });
      const bodyJson = JSON.stringify(editor.getJSON());
      shown.current = bodyJson;
      typed.current = Date.now();
      onSave(note.id, { bodyJson, bodyText, title: titleFrom(bodyText) });
    },
  });
  // Si la nota cambia en otro dispositivo, el texto se pone al día aquí, salvo
  // mientras se está escribiendo: entonces espera a una pausa.
  const shown = useRef(note.bodyJson);
  const typed = useRef(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!editor || note.bodyJson === shown.current) return;
    const quiet = Date.now() - typed.current;
    if (editor.isFocused && quiet < 1500) {
      const t = setTimeout(() => setRetry((n) => n + 1), 1500 - quiet);
      return () => clearTimeout(t);
    }
    shown.current = note.bodyJson;
    applyRemote(editor, parseBody(note.bodyJson));
  }, [editor, note.bodyJson, retry]);
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  // Y se guardan así, para que la vista previa y la búsqueda también las vean bien.
  useEffect(() => {
    if (!editor || !initial.repaired) return;
    const bodyText = editor.getText({ blockSeparator: '\n' });
    shown.current = JSON.stringify(editor.getJSON());
    onSave(note.id, { bodyJson: shown.current, bodyText, title: titleFrom(bodyText) });
    // Solo una vez, al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  return <EditorContent editor={editor} className="sheet-editor" />;
}

function openLink(e: MouseEvent, any = false) {
  if (!any && !(e.ctrlKey || e.metaKey)) return false;
  const a = (e.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return false;
  e.preventDefault();
  window.open(a.href, '_blank', 'noopener,noreferrer');
  return true;
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
  // Modo nodo: la nota en el centro de la vista de nodos.
  onNodes: () => void;
  onArchive: () => void;
  onLink: () => void;
  onUnlink: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
  // Secciones a las que se puede mover y la ruta de la actual.
  sections: SectionOption[];
  onMove: (zoneId: string | null) => void;
  // Para las notas de tipo canvas.
  rows: NoteRow[];
  onRename: (title: string) => void;
  onPickNote: (then: (id: string) => void) => void;
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

export function NoteSheet({ note, neighbors, defs, from, onNavigate, onSave, onCycle, onProps, onTask, onBlock, onNodes, onArchive, onLink, onUnlink, onDelete, onClose, onError, sections, onMove, rows, onRename, onPickNote }: Props) {
  const { maduran } = useExperiments();
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const [moving, setMoving] = useState(false);
  // La ruta de notas madre, para poder ir a cada una por su clic.
  const chain = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = parentMap(rows);
    const up: NoteRow[] = [];
    for (let z = byId.get(parent.get(note.id) ?? ''); z && up.length < 20; z = byId.get(parent.get(z.id) ?? '')) up.unshift(z);
    return up;
  }, [rows, note.id]);
  // Ella y todo lo que cuelga de ella: no puede ir dentro de sí misma.
  const family = useMemo(() => {
    const out = new Set([note.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) if (r.zoneId && out.has(r.zoneId) && !out.has(r.id)) grew = !!out.add(r.id);
    }
    return out;
  }, [rows, note.id]);
  const isCanvas = note.kind === 'canvas';
  const whereButton = (
    <div className="sheet-where meta">
      {chain.length ? (
        chain.map((z, i) => (
          <span key={z.id} className="sheet-where-wrap">
            {i > 0 && <span className="sheet-where-sep">›</span>}
            <button className="sheet-where-crumb" onClick={() => onNavigate(z.id)}>
              {z.title || 'Nota sin título'}
            </button>
          </span>
        ))
      ) : (
        <span className="sheet-where-empty">Arriba del todo</span>
      )}
      <button className="sheet-where-move" onClick={() => setMoving(true)} title="Mover dentro de otra nota">
        Mover
      </button>
    </div>
  );
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
      // Escribiendo en una tarjeta del canvas, Esc solo termina de escribir.
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && t?.closest('.board') && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      // Ctrl/⌘ A fuera del texto (tras pulsar un botón, al abrir…) selecciona
      // la nota, no la página entera.
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyA' && !typing && editorRef.current && !document.querySelector('.inspector, .overlay')) {
        e.preventDefault();
        editorRef.current.chain().focus().selectAll().run();
        return;
      }
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
    <div ref={ref} className={`sheet${isCanvas ? ' is-canvas' : ''}`} style={(hue !== undefined ? { '--hue': hue } : {}) as CSSProperties}>
      <header className="sheet-top meta">
        <button className="sheet-back" onClick={() => close()}>
          <BackArrow /> Volver
        </button>
        <span className="sheet-actions">
          {!isCanvas && (
            <button className="sheet-back" onClick={onTask}>
              {note.kind === 'task' ? 'Quitar tarea' : 'Hacer tarea'}
            </button>
          )}
          {note.kind === 'task' && (
            <button className="sheet-back" onClick={onBlock}>
              {note.status === 'blocked' ? 'Desbloquear' : 'Bloquear'}
            </button>
          )}
          <button className="sheet-back" onClick={onNodes} title="Ver esta nota en el centro, con sus relaciones (Ctrl G)">
            Nodos
          </button>
          <button className="sheet-back" onClick={onArchive} title="Archivar: se oculta con lo que cuelga de ella (Ctrl Mayús X)">
            {note.archivedAt ? 'Desarchivar' : 'Archivar'}
          </button>
          <button className="sheet-back" onClick={() => onProps(note.id)}>
            Propiedades
          </button>
          <button className="sheet-back danger" onClick={() => close(() => onDelete(note.id))}>
            Borrar
          </button>
        </span>
      </header>
      {isCanvas ? (
        <div className="sheet-canvas" key={note.id + note.kind}>
          <div className="sheet-canvas-head">
            {whereButton}
            <input
              className="sheet-canvas-title"
              defaultValue={note.title ?? ''}
              placeholder="Canvas sin título"
              autoFocus={!note.title}
              onChange={(e) => onRename(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </div>
          <CanvasBoard
            note={note}
            rows={rows}
            onSave={(c) => onSave(note.id, { ...c, title: note.title })}
            onOpenNote={onNavigate}
            onPickNote={onPickNote}
            onError={onError}
          />
        </div>
      ) : (
      <article className="sheet-body" key={note.id + note.kind}>
        {whereButton}
        {note.kind === 'task' && <TaskGlyph status={note.status ?? 'todo'} ripe={maduran} onCycle={() => onCycle(note.id)} />}
        <SheetEditor note={note} onSave={onSave} onError={onError} editorRef={editorRef} />
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
      )}
      {moving && (
        <SectionPicker
          options={sections}
          current={note.zoneId}
          exclude={family}
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
