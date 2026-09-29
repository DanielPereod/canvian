import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { NoteRow, PropertyDef } from '../api';
import { applyRemote, editingExtensions, extensions, parseBody, titleFrom } from './editor';
import { repairTables } from './markdown';
import { NoteChips } from './NoteChips';
import { TaskGlyph } from './TaskGlyph';
import { MediaUpload } from './media';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { CanvasBoard } from './board/CanvasBoard';
import { Resizer, useSideWidth } from './Resizer';
import { BackArrow } from '../BackArrow';
import { parentMap } from './sections';
import { decodeTime } from 'ulidx';
import { editedLabel, kindOf } from './Biblioteca';
import { WikiSuggest, splitWiki, wikiLinksIn, type WikiQuery } from './obsidian';
import { WikiMenu, type WikiItem } from './WikiMenu';

// Una nota se abre como lector: el texto a la izquierda y un panel de detalles
// a la derecha. Un canvas se abre en su hoja, con el lienzo a pantalla completa.

const MAX_LINKS = 24;

export type NoteContent = { bodyJson: string; bodyText: string; title: string | null };

// [[Enlaces]] a otras notas: abrir la enlazada, unir las dos notas en el mapa
// y crear la nota si aún no existe (devuelve su id).
export type WikiHandlers = { rows: NoteRow[]; onOpen: (id: string) => void; onLink: (id: string) => void; onCreate: (title: string) => string };

type EditorProps = { note: NoteRow; onSave: (id: string, content: NoteContent) => void; onError: (e: unknown) => void; editorRef: { current: Editor | null }; wiki: WikiHandlers };

const sameTitle = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

function SheetEditor({ note, onSave, onError, editorRef, wiki }: EditorProps) {
  // Tablas de Markdown que quedaron como texto con barras: se abren ya como tablas.
  const [initial] = useState(() => {
    const doc = parseBody(note.bodyJson);
    return { doc: repairTables(doc) ?? doc, repaired: !!repairTables(doc) };
  });
  // El editor se crea una vez: lo que cambia le llega por referencias.
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;
  const [query, setQuery] = useState<WikiQuery | null>(null);
  const menuKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const [suggest] = useState(() => WikiSuggest.configure({ onChange: setQuery, onKey: (e) => menuKeys.current(e) }));
  // Las notas enlazadas con [[ ]] en el texto. Una que aparece nueva se une a
  // esta en el mapa; las que ya estaban al abrir no (quizá se quitó a mano).
  const linked = useRef<Set<string> | null>(null);
  const syncWiki = (ed: Editor) => {
    const { rows, onLink } = wikiRef.current;
    const tr = ed.state.tr;
    const ids = new Set<string>();
    for (const { node, pos } of wikiLinksIn(ed.state.doc)) {
      let id = node.attrs.id as string | null;
      // Escrita a mano o importada: se busca por su nombre.
      if (!id) {
        const name = splitWiki(node.attrs.target as string).note;
        id = rows.find((r) => r.id !== note.id && sameTitle(r.title ?? '', name))?.id ?? null;
        if (id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
      }
      if (id && id !== note.id) ids.add(id);
    }
    if (linked.current) for (const id of ids) if (!linked.current.has(id)) onLink(id);
    linked.current = ids;
    if (!tr.docChanged) return false;
    ed.view.dispatch(tr.setMeta('addToHistory', false));
    return true;
  };
  const editor = useEditor({
    extensions: [...extensions, ...editingExtensions, MediaUpload.configure({ onError }), suggest],
    content: initial.doc ?? '',
    // Abrir una nota es para escribir: el cursor ya está al final, pero la
    // nota se ve desde el principio (sin saltar hasta el cursor).
    onCreate: ({ editor }) => {
      syncWiki(editor);
      editor.commands.focus('end', { scrollIntoView: false });
    },
    editorProps: {
      attributes: { class: 'note-body prose sheet-prose' },
      // Clic en un [[enlace]] abre esa nota; Ctrl/⌘ clic (o clic central) abre
      // un enlace web en otra pestaña.
      handleClick: (view, _pos, e) => openWiki(view.dom, e) || openLink(e),
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
      // Si ha puesto el id a algún [[enlace]], ese cambio ya se guardó.
      if (syncWiki(editor)) return;
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

  // Abre la nota de un [[enlace]]; si no existe, la crea (como Obsidian).
  const openWiki = (root: HTMLElement, e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest('a[data-wikilink]') as HTMLElement | null;
    const ed = editorRef.current;
    if (!el || !root.contains(el) || !ed) return false;
    e.preventDefault();
    const { rows, onOpen, onCreate } = wikiRef.current;
    const name = splitWiki(el.dataset.target ?? '').note;
    let id = el.dataset.id && rows.some((r) => r.id === el.dataset.id) ? el.dataset.id : undefined;
    id ??= rows.find((r) => r.id !== note.id && sameTitle(r.title ?? '', name))?.id;
    if (!id && !name) return true;
    id ??= onCreate(name);
    if (id !== el.dataset.id) {
      const pos = ed.view.posAtDOM(el, 0);
      const node = ed.state.doc.nodeAt(pos);
      if (node?.type.name === 'wikilink') ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, id }));
    }
    onOpen(id);
    return true;
  };

  const pick = (item: WikiItem) => {
    if (!editor || !query) return;
    const { section, alias } = splitWiki(query.query);
    const title = item.kind === 'note' ? item.row.title || 'Nota sin título' : item.title;
    const id = item.kind === 'note' ? item.row.id : wikiRef.current.onCreate(item.title);
    // Si ya estaban los «]]» de cierre, también se los lleva.
    const { doc } = editor.state;
    const to = doc.textBetween(query.to, Math.min(query.to + 2, doc.content.size), '') === ']]' ? query.to + 2 : query.to;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: query.from, to }, { type: 'wikilink', attrs: { id, target: section ? `${title}#${section}` : title, alias } })
      .run();
  };

  return (
    <>
      <EditorContent editor={editor} className="sheet-editor" />
      {query && <WikiMenu query={query} rows={wiki.rows} exclude={note.id} onPick={pick} keys={menuKeys} />}
    </>
  );
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
  // Unir esta nota con otra (al escribir un [[enlace]]).
  onConnect: (id: string) => void;
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
  // Crear una nota para un [[enlace]] que aún no existe; devuelve su id.
  onCreateLinked: (title: string) => string;
};

export function NoteSheet({ note, neighbors, defs, onNavigate, onSave, onCycle, onProps, onTask, onBlock, onNodes, onArchive, onLink, onConnect, onUnlink, onDelete, onClose, onError, sections, onMove, rows, onRename, onPickNote, onCreateLinked }: Props) {
  const sideWidth = useSideWidth('canvian.readerWidth', 300, 240, 560);
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
  const wiki: WikiHandlers = { rows, onOpen: onNavigate, onLink: onConnect, onCreate: onCreateLinked };

  // Solo al abrir: navegar entre notas cambia el contenido, no la hoja.
  useLayoutEffect(() => {
    ref.current!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }, []);

  const close = (then: () => void = onClose) => {
    const el = ref.current;
    if (!el || leaving.current) return;
    leaving.current = true;
    el.classList.add('is-leaving');
    then();
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
      if (e.key === 'Escape' && !document.querySelector('.inspector, .overlay, .wiki-suggest')) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const picker = moving && (
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
  );

  if (!isCanvas) {
    const kids = rows.filter((r) => r.zoneId === note.id).length;
    const madre = chain.at(-1);
    let created = '—';
    try {
      created = editedLabel(new Date(decodeTime(note.id)).toISOString());
    } catch {
      // Un id que no es ULID no dice cuándo se creó.
    }
    const words = (note.bodyText ?? '').split(/\s+/).filter(Boolean).length;
    const task = note.kind === 'task';
    return (
      <div ref={ref} className="sheet is-reader" style={{ '--reader-w': `${sideWidth.width}px` } as CSSProperties}>
        <div className="reader-main">
          <article className="reader-body" key={note.id + note.kind}>
            <span className="reader-meta">
              {madre ? madre.title || 'Nota sin título' : 'Arriba del todo'} · {kindOf(note, kids)} · editada {editedLabel(note.updatedAt)}
            </span>
            {task && <TaskGlyph status={note.status ?? 'todo'} onCycle={() => onCycle(note.id)} />}
            <SheetEditor note={note} onSave={onSave} onError={onError} editorRef={editorRef} wiki={wiki} />
            <NoteChips note={note} defs={defs} onOpen={() => onProps(note.id)} />
          </article>
        </div>
        <Resizer size={sideWidth} edge="left" className="reader-resizer" />
        <aside className="reader-side" aria-label="Detalles de la nota">
          <span className="reader-side-h">Detalles</span>
          <dl className="reader-facts">
            <dt>Tipo</dt>
            <dd>{kindOf(note, kids)}</dd>
            <dt>Madre</dt>
            <dd>
              <button className="reader-madre" onClick={() => setMoving(true)} title="Mover dentro de otra nota">
                {madre ? madre.title || 'Nota sin título' : 'Arriba del todo'}
              </button>
            </dd>
            {kids > 0 && (
              <>
                <dt>Dentro</dt>
                <dd>{kids === 1 ? '1 nota' : `${kids} notas`}</dd>
              </>
            )}
            <dt>Creada</dt>
            <dd>{created}</dd>
            <dt>Editada</dt>
            <dd>{editedLabel(note.updatedAt)}</dd>
            <dt>Palabras</dt>
            <dd>{words}</dd>
          </dl>
          <div className="reader-rule" />
          <div className="reader-side-row">
            <span className="reader-side-h">Enlaces</span>
            <span className="reader-muted">{neighbors.length}</span>
          </div>
          <div className="reader-links">
            {shown.map((n) => (
              <span key={n.id} className="reader-link">
                <button className="reader-link-go" onClick={() => onNavigate(n.id)}>
                  <span className="reader-link-g" aria-hidden="true">
                    {n.kind === 'task' ? (n.status === 'done' ? '■' : '□') : '·'}
                  </span>
                  <span className="reader-ellipsis">{n.title || 'Nota sin título'}</span>
                </button>
                <button className="reader-link-x" onClick={() => onUnlink(n.id)} aria-label={`Quitar el enlace con ${n.title || 'esta nota'}`} title="Quitar enlace">
                  ×
                </button>
              </span>
            ))}
            {neighbors.length > MAX_LINKS && <span className="reader-muted">+{neighbors.length - MAX_LINKS} más</span>}
            <button className="reader-add" onClick={onLink}>
              ＋ Enlazar
            </button>
          </div>
          <div className="reader-actions">
            <button onClick={onTask}>{task ? 'Quitar tarea' : 'Hacer tarea'}</button>
            {task && <button onClick={onBlock}>{note.status === 'blocked' ? 'Desbloquear' : 'Bloquear'}</button>}
            <button onClick={onNodes} title="Ver esta nota en el centro, con sus relaciones (Ctrl G)">
              Nodos
            </button>
            <button onClick={onArchive} title="Archivar: se oculta con lo que cuelga de ella (Ctrl Mayús X)">
              {note.archivedAt ? 'Desarchivar' : 'Archivar'}
            </button>
            <button onClick={() => onProps(note.id)}>Propiedades</button>
            <button className="danger" onClick={() => close(() => onDelete(note.id))}>
              Borrar
            </button>
          </div>
        </aside>
        {picker}
      </div>
    );
  }

  return (
    <div ref={ref} className="sheet is-canvas">
      <header className="sheet-top meta">
        <button className="sheet-back" onClick={() => close()}>
          <BackArrow /> Volver
        </button>
        <span className="sheet-actions">
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
      {picker}
    </div>
  );
}
