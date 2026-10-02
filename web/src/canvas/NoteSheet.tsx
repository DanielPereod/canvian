import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { NoteRow, PropertyDef } from '../api';
import { applyRemote, bodyToHtml, editingExtensions, extensions, joinTitle, parseBody, splitTitle, titleBlock, titleFrom } from './editor';
import { repairDoc, sourceOf, sourceToDoc } from './markdown';
import { NoteChips } from './NoteChips';
import { taskCount } from './tasks';
import { MediaUpload, YouTubePaste, attachFiles } from './media';
import { editLink, embedLink, embedOf, linkAt, unlink, type LinkHit } from './links';
import { setNoteSource } from './embeds';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { CanvasBoard } from './board/CanvasBoard';
import { Resizer, useSideWidth } from './Resizer';
import { parentMap } from './sections';
import { decodeTime } from 'ulidx';
import { editedLabel, kindOf, useContextMenu } from './Biblioteca';
import { WikiSuggest, splitWiki, wikiLinksIn, type WikiQuery } from './obsidian';
import { WikiMenu, type WikiItem } from './WikiMenu';
import { SlashSuggest, type SlashQuery } from './slash';
import { BlockHandle, FormatBar, MobileBar, SlashMenu } from './EditorMenus';
import { TableControls } from './TableMenus';
import { actionFor, keyParts, keysBlocked, matches, useKeymap } from '../keys';
import { toggleWide, useWide } from './widePrefs';
import { t, tn } from '../i18n';

// Una nota se abre como lector: el texto a la izquierda y un panel de detalles
// a la derecha. Un canvas se abre en su hoja, con el lienzo a pantalla completa.

const MAX_LINKS = 24;

// El panel de detalles plegado: el texto se queda solo y el panel vuelve con un
// botón arriba a la derecha (o Ctrl Alt D). Vale para todas las notas.
const FOLD_KEY = 'canvian.readerFolded';
function useReaderFolded() {
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setFolded((v) => {
      try {
        localStorage.setItem(FOLD_KEY, v ? '0' : '1');
      } catch {
        // Sin almacenamiento local se olvida al recargar; nada más.
      }
      return !v;
    });
  return [folded, toggle] as const;
}

const PanelIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M14.5 5v14" />
  </svg>
);

const DotsIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </svg>
);

type SheetItem = { label: string; title?: string; keys?: string; danger?: boolean; run: () => void } | null;

// Las acciones de la nota, en un menú desde el botón de los tres puntos.
function SheetMenu({ x, y, items, onClose }: { x: number; y: number; items: SheetItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  return (
    <div className="bib-menu reader-menu" ref={ref} role="menu" aria-label={t('Acciones de la nota')} style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it ? (
          <button
            key={it.label}
            role="menuitem"
            className={`bib-menu-it${it.danger ? ' is-danger' : ''}`}
            title={it.title}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
            {it.keys && <span className="bib-menu-k">{it.keys}</span>}
          </button>
        ) : (
          <div key={`s${i}`} className="bib-menu-sep" role="separator" />
        ),
      )}
    </div>
  );
}

export type NoteContent = { bodyJson: string; bodyText: string; title: string | null };

// [[Enlaces]] a otras notas: abrir la enlazada, unir las dos notas en el mapa
// y crear la nota si aún no existe (devuelve su id).
export type WikiHandlers = { rows: NoteRow[]; onOpen: (id: string) => void; onLink: (id: string) => void; onCreate: (title: string) => string };

// `source`: en vez del texto con formato, su Markdown para verlo y editarlo.
type EditorProps = { note: NoteRow; onSave: (id: string, content: NoteContent) => void; onError: (e: unknown) => void; editorRef: { current: Editor | null }; wiki: WikiHandlers; source: boolean };

const sameTitle = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

// Una nota cuyo texto empieza por una lista, una tabla… no tiene bloque de
// título: se enseña el título guardado de la nota (el del archivo importado,
// por ejemplo), salvo que sea la misma primera línea del texto. Al escribirlo
// pasa a ser su primer bloque, como en las demás.
function withTitle(split: ReturnType<typeof splitTitle>, note: NoteRow): ReturnType<typeof splitTitle> {
  const saved = note.title?.trim();
  if (split.head || !saved) return split;
  const firstLine = (note.bodyText ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return sameTitle(firstLine, saved) ? split : { ...split, title: saved };
}

function SheetEditor({ note, onSave, onError, editorRef, wiki, source }: EditorProps) {
  // Lo que se importó mal antes (tablas como texto con barras, direcciones con
  // _ hechas cursiva o sin enlace) se abre ya arreglado.
  const [initial] = useState(() => {
    const doc = parseBody(note.bodyJson);
    const fixed = repairDoc(doc);
    return { ...withTitle(splitTitle(fixed ?? doc), note), repaired: !!fixed };
  });
  // El título, aparte del texto (como en Notion). `head` es su bloque tal como
  // estaba guardado, para no perderle el formato si no se toca.
  const [title, setTitle] = useState(initial.title);
  const titleRef = useRef(initial.title);
  const head = useRef(initial.head);
  const titleBox = useRef<HTMLTextAreaElement>(null);
  // Lo que se guarda: el título como primer bloque y después el texto.
  const contentOf = (ed: Editor) => {
    head.current = titleBlock(titleRef.current, head.current);
    const doc = joinTitle(head.current, ed.getJSON());
    const text = ed.getText({ blockSeparator: '\n' });
    const bodyText = head.current ? `${titleRef.current}\n${text}` : text;
    return { bodyJson: JSON.stringify(doc), bodyText, title: titleFrom(bodyText) };
  };
  // El editor se crea una vez: lo que cambia le llega por referencias.
  const wikiRef = useRef(wiki);
  wikiRef.current = wiki;
  // Las notas incrustadas (![[Nota]]) se buscan entre las de la biblioteca y
  // se repintan cuando alguna cambia.
  useEffect(() => {
    setNoteSource({
      find: (id, target) => {
        const { rows } = wikiRef.current;
        const name = splitWiki(target).note;
        const row = (id && rows.find((r) => r.id === id)) || rows.find((r) => sameTitle(r.title ?? '', name));
        return row ? { id: row.id, title: row.title ?? '', bodyJson: row.bodyJson } : null;
      },
      open: (id) => wikiRef.current.onOpen(id),
      // Sin el título, que ya está en la cabecera.
      html: (bodyJson) => bodyToHtml(JSON.stringify(splitTitle(parseBody(bodyJson)).body)),
    });
  }, [wiki.rows]);
  useEffect(() => () => setNoteSource(null), []);
  const [query, setQuery] = useState<WikiQuery | null>(null);
  const menuKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const [suggest] = useState(() => WikiSuggest.configure({ onChange: setQuery, onKey: (e) => menuKeys.current(e) }));
  // El menú «/» de bloques, como en Notion.
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  // Clic derecho en un enlace: su menú.
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; hit: LinkHit } | null>(null);
  const slashKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const [slashExt] = useState(() => SlashSuggest.configure({ onChange: setSlash, onKey: (e) => slashKeys.current(e) }));
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
    extensions: [...extensions, ...editingExtensions, MediaUpload.configure({ onError }), YouTubePaste, suggest, slashExt],
    content: initial.body.content?.length ? initial.body : '',
    // Abrir una nota es para escribir: el cursor ya está al final, pero la
    // nota se ve desde el principio (sin saltar hasta el cursor). Una nota
    // nueva, sin nada, empieza por el título.
    onCreate: ({ editor }) => {
      syncWiki(editor);
      if (!initial.title && editor.isEmpty) titleBox.current?.focus({ preventScroll: true });
      else editor.commands.focus('end', { scrollIntoView: false });
    },
    editorProps: {
      attributes: { class: 'note-body prose sheet-prose' },
      // Clic en un [[enlace]] abre esa nota; Ctrl/⌘ clic (o clic central) abre
      // un enlace web en otra pestaña.
      handleClick: (view, _pos, e) => e.button === 0 && (openWiki(view.dom, e) || openLink(e)),
      // Del principio del texto se sube al título: con la flecha arriba en la
      // primera línea, o con borrar al principio (y entonces se le une esa línea).
      handleKeyDown: (view, e) => {
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
        const { selection, doc } = view.state;
        const { $from, empty } = selection;
        const atFirst = empty && $from.depth === 1 && $from.index(0) === 0;
        if (e.key === 'ArrowUp' && atFirst && view.endOfTextblock('up')) {
          e.preventDefault();
          focusTitle(titleRef.current.length);
          return true;
        }
        if (e.key === 'Backspace' && atFirst && $from.parentOffset === 0) {
          const first = doc.firstChild!;
          let plain = first.isTextblock;
          first.forEach((c) => {
            if (!c.isText) plain = false;
          });
          if (!plain) return false;
          e.preventDefault();
          const at = titleRef.current.length;
          if (first.textContent) caret.current = at;
          typeTitle(titleRef.current + first.textContent, false);
          if (doc.childCount > 1) view.dispatch(view.state.tr.delete(0, first.nodeSize));
          else view.dispatch(view.state.tr.delete(1, first.nodeSize - 1));
          focusTitle(at);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        auxclick: (_view, e) => e.button === 1 && openLink(e, true),
        contextmenu: (view, e) => {
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          if (!at) return false;
          const hit = [at.inside, at.pos, at.pos - 1].map((p) => (p >= 0 ? linkAt(view.state, p) : null)).find(Boolean);
          if (!hit) return false;
          e.preventDefault();
          setLinkMenu({ x: e.clientX, y: e.clientY, hit });
          return true;
        },
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
      const content = contentOf(editor);
      shown.current = content.bodyJson;
      typed.current = Date.now();
      onSave(note.id, content);
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
    const typing = editor.isFocused || source || document.activeElement === titleBox.current;
    if (typing && quiet < 1500) {
      const timer = setTimeout(() => setRetry((n) => n + 1), 1500 - quiet);
      return () => clearTimeout(timer);
    }
    shown.current = note.bodyJson;
    const parsed = parseBody(note.bodyJson);
    const remote = withTitle(splitTitle(repairDoc(parsed) ?? parsed), note);
    head.current = remote.head;
    titleRef.current = remote.title;
    setTitle(remote.title);
    applyRemote(editor, remote.body);
    if (source) setMd(sourceOf(editor.getJSON()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, note.bodyJson, retry]);

  // El modo Markdown: se escribe del texto al entrar, y lo que se teclea se lee
  // de vuelta al editor (que sigue ahí, oculto, y es quien guarda).
  const [md, setMd] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const wasSource = useRef(false);
  useLayoutEffect(() => {
    if (!editor) return;
    if (source) {
      setMd(sourceOf(editor.getJSON()));
      requestAnimationFrame(() => area.current?.focus({ preventScroll: true }));
    } else if (wasSource.current) editor.commands.focus(null, { scrollIntoView: false });
    wasSource.current = source;
  }, [editor, source]);
  // El cuadro crece con lo escrito, como el texto normal; también si cambia
  // de ancho o termina de cargar la letra (las líneas parten en otro sitio).
  const fit = () => {
    const el = area.current;
    if (!el) return;
    // Al medir encoge un instante: que la hoja no salte de donde estaba.
    const scroller = el.closest('.reader-main');
    const top = scroller?.scrollTop ?? 0;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (scroller) scroller.scrollTop = top;
  };
  useLayoutEffect(fit, [md, source]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [source]);
  const typeSource = (value: string) => {
    setMd(value);
    if (editor) editor.commands.setContent(sourceToDoc(value, editor.getJSON()), { emitUpdate: true });
  };
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  // Y se guardan así, para que la vista previa y la búsqueda también las vean bien.
  useEffect(() => {
    if (!editor || !initial.repaired) return;
    const content = contentOf(editor);
    shown.current = content.bodyJson;
    onSave(note.id, content);
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

  // El título: una sola línea lógica que parte en varias si no cabe.
  const fitTitle = () => {
    const el = titleBox.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Si el título acaba de cambiar desde el texto (al unirle una línea), el
  // cursor vuelve a donde se unieron.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    fitTitle();
    if (caret.current !== null && document.activeElement === titleBox.current) titleBox.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [title]);
  useEffect(() => {
    const el = titleBox.current;
    if (!el) return;
    const ro = new ResizeObserver(fitTitle);
    ro.observe(el);
    void document.fonts?.ready.then(fitTitle);
    return () => ro.disconnect();
  }, []);
  const typeTitle = (value: string, save = true) => {
    const clean = value.replace(/[\r\n]+/g, ' ');
    titleRef.current = clean;
    setTitle(clean);
    if (!save || !editor) return;
    const content = contentOf(editor);
    shown.current = content.bodyJson;
    typed.current = Date.now();
    onSave(note.id, content);
  };
  const focusTitle = (at: number) => {
    const el = titleBox.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
  };
  // Intro en el título baja al texto; si el cursor estaba en medio, lo que
  // queda a la derecha pasa a ser la primera línea del texto.
  const titleKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (!editor || e.nativeEvent.isComposing) return;
    const end = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const rest = el.value.slice(el.selectionEnd);
      if (rest) {
        editor.chain().insertContentAt(0, { type: 'paragraph', content: [{ type: 'text', text: rest }] }).focus(1).run();
        typeTitle(el.value.slice(0, el.selectionStart));
      } else editor.commands.focus('start');
    } else if (e.key === 'ArrowDown' && end && !e.shiftKey) {
      e.preventDefault();
      editor.commands.focus('start');
    }
  };

  return (
    <>
      <textarea
        ref={titleBox}
        className="sheet-title"
        rows={1}
        value={title}
        onChange={(e) => typeTitle(e.target.value)}
        onKeyDown={titleKeys}
        placeholder={t('Sin título')}
        aria-label={t('Título de la nota')}
        spellCheck={false}
      />
      <EditorContent editor={editor} className="sheet-editor" hidden={source} />
      {source && (
        <textarea
          ref={area}
          className="note-body sheet-prose sheet-source"
          value={md}
          onChange={(e) => typeSource(e.target.value)}
          spellCheck={false}
          aria-label={t('Markdown de la nota')}
          placeholder={t('Escribe algo…')}
        />
      )}
      {!source && query && <WikiMenu query={query} rows={wiki.rows} exclude={note.id} onPick={pick} keys={menuKeys} />}
      {!source && slash && editor && <SlashMenu query={slash} editor={editor} onError={onError} keys={slashKeys} />}
      {/* Encima de todo, para que el panel lateral no lo tape. */}
      {!source &&
        editor &&
        linkMenu &&
        createPortal(
          <SheetMenu
            x={linkMenu.x}
            y={linkMenu.y}
            onClose={() => setLinkMenu(null)}
            items={linkItems(editor, linkMenu.hit, (el) => openWiki(editor.view.dom, { target: el, preventDefault: () => {} } as unknown as MouseEvent))}
          />,
          document.body,
        )}
      {!source && editor && (
        <>
          <BlockHandle editor={editor} />
          <FormatBar editor={editor} />
          <TableControls editor={editor} />
          <MobileBar editor={editor} />
        </>
      )}
    </>
  );
}

// Lo que se puede hacer con un enlace desde su menú (clic derecho).
function linkItems(editor: Editor, hit: LinkHit, openNote: (el: HTMLElement) => void): SheetItem[] {
  const { view } = editor;
  const web = hit.kind === 'web';
  const open = () => {
    if (web) window.open(hit.href, '_blank', 'noopener,noreferrer');
    else if (view.nodeDOM(hit.from) instanceof HTMLElement) openNote(view.nodeDOM(hit.from) as HTMLElement);
  };
  return [
    { label: web ? t('Abrir enlace') : t('Abrir'), run: open },
    { label: t('Editar'), run: () => editLink(view, hit) },
    ...(embedOf(view.state, hit) ? [{ label: t('Ver incrustado'), run: () => embedLink(view, hit) }] : []),
    ...(web ? [{ label: t('Copiar enlace'), run: () => void navigator.clipboard?.writeText(hit.href).catch(() => {}) }] : []),
    null,
    { label: t('Quitar enlace'), run: () => unlink(view, hit) },
  ];
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
  onProps: (id: string) => void;
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
  // Modo zen: sin nada alrededor, solo el texto.
  zen: boolean;
  onZen: (on: boolean) => void;
};

export function NoteSheet({ note, neighbors, defs, onNavigate, onSave, onProps, onNodes, onArchive, onLink, onConnect, onUnlink, onDelete, onClose, onError, sections, onMove, rows, onRename, onPickNote, onCreateLinked, zen, onZen }: Props) {
  const sideWidth = useSideWidth('canvian.readerWidth', 300, 240, 560);
  const ref = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const [moving, setMoving] = useState(false);
  const [folded, toggleFolded] = useReaderFolded();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // El clic que cierra el menú al pulsar fuera no debe volver a abrirlo si cae en su botón.
  const menuClosedAt = useRef(0);
  const closeMenu = () => {
    menuClosedAt.current = performance.now();
    setMenu(null);
  };
  // El sitio de la barra de arriba donde van los botones de la nota (si la hay).
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setBarSlot(document.getElementById('bib-bar-tools')), []);
  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (performance.now() - menuClosedAt.current < 250) return;
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ x: box.right - 240, y: box.bottom + 6 });
  };
  // Ver la nota como Markdown (Ctrl E): sigue así al pasar de una nota a otra.
  const [source, setSource] = useState(false);
  // Modo ancho: cada nota recuerda el suyo.
  const wide = useWide(note.id);
  const flipWide = () => void toggleWide(note.id).catch(onError);
  // Al entrar o salir desde un botón que desaparece, se sigue escribiendo.
  const setZen = (on: boolean) => {
    onZen(on);
    requestAnimationFrame(() => {
      if (document.activeElement?.closest('.sheet-editor, .sheet-source')) return;
      const area = ref.current?.querySelector<HTMLTextAreaElement>('.sheet-source');
      if (area) area.focus({ preventScroll: true });
      else editorRef.current?.commands.focus(null, { scrollIntoView: false });
    });
  };
  const keymap = useKeymap();
  const keysOf = (combo: string) => keyParts(combo).join(' ');
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
      const target = e.target as HTMLElement | null;
      if (e.key === 'Escape' && target?.closest('.board, .bib-crumbs') && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      // Dibujando en el canvas, Esc suelta la herramienta o lo elegido.
      if (e.key === 'Escape' && document.querySelector('.board[data-esc]')) return;
      // Ctrl/⌘ A fuera del texto (tras pulsar un botón, al abrir…) selecciona
      // la nota, no la página entera.
      // Antes que el editor, que con Ctrl E pondría el texto como código.
      if (!isCanvas && matches(e, 'markdownSource') && !keysBlocked() && !document.querySelector('.inspector, .overlay')) {
        e.preventDefault();
        e.stopPropagation();
        setSource((s) => !s);
        return;
      }
      if (!keysBlocked() && !document.querySelector('.inspector, .overlay') && (matches(e, 'zen') || (!isCanvas && (matches(e, 'wideNote') || matches(e, 'details'))))) {
        e.preventDefault();
        e.stopPropagation();
        if (matches(e, 'zen')) setZen(!zen);
        else if (matches(e, 'wideNote')) flipWide();
        else if (!zen) toggleFolded();
        return;
      }
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      // Mover, enlazar y adjuntar (desde la paleta, o M fuera del texto).
      const act = !typing && !keysBlocked() && !document.querySelector('.inspector, .overlay') ? actionFor(e, isCanvas ? ['move'] : ['move', 'linkNote', 'attach']) : null;
      if (act) {
        e.preventDefault();
        e.stopPropagation();
        if (act === 'move') setMoving(true);
        else if (act === 'linkNote') onLink();
        else filePick.current?.click();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyA' && !typing && editorRef.current && !document.querySelector('.inspector, .overlay')) {
        e.preventDefault();
        editorRef.current.chain().focus().selectAll().run();
        return;
      }
      if (e.key === 'Escape' && !document.querySelector('.inspector, .overlay, .wiki-suggest, .bib-menu')) {
        e.preventDefault();
        e.stopPropagation();
        // En modo zen, Esc sale del modo y deja la nota abierta.
        if (zen) setZen(false);
        else close();
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

  const zenExit = zen && (
    <button className="reader-zen-exit" onClick={() => setZen(false)} title={t('Salir del modo zen (Esc)')}>
      {t('Salir del modo zen')} <span className="reader-zen-k">Esc</span>
    </button>
  );

  if (!isCanvas) {
    // Lo que tiene dentro, como el contenido de una carpeta: madres primero y por nombre.
    const inside = rows
      .filter((r) => r.zoneId === note.id)
      .map((r) => ({ r, n: rows.filter((k) => k.zoneId === r.id).length }))
      .sort((a, b) => Number(!!b.n) - Number(!!a.n) || (a.r.title || '').localeCompare(b.r.title || '', 'es', { numeric: true }));
    const kids = inside.length;
    const madre = chain.at(-1);
    let created = '—';
    try {
      created = editedLabel(new Date(decodeTime(note.id)).toISOString());
    } catch {
      // Un id que no es ULID no dice cuándo se creó.
    }
    const words = (note.bodyText ?? '').split(/\s+/).filter(Boolean).length;
    const tasks = taskCount(note);
    const items: SheetItem[] = [
      { label: t('Adjuntar archivos…'), title: t('PDF, documentos, imágenes… donde está el cursor; también se pueden pegar o soltar en el texto'), run: () => filePick.current?.click() },
      { label: t('Ver en nodos'), title: t('Esta nota en el centro, con sus relaciones'), keys: keysOf(keymap.nodes), run: onNodes },
      null,
      { label: source ? t('Ver el texto') : t('Ver el Markdown'), keys: keysOf(keymap.markdownSource), run: () => setSource((s) => !s) },
      { label: wide ? t('Texto estrecho') : t('Texto ancho'), keys: keysOf(keymap.wideNote), run: flipWide },
      { label: t('Modo zen'), title: t('Quitar toda la interfaz y quedarse solo con el texto (Esc para salir)'), keys: keysOf(keymap.zen), run: () => setZen(true) },
      null,
      { label: t('Propiedades'), run: () => onProps(note.id) },
      { label: t('Mover a…'), title: t('Meterla dentro de otra nota'), keys: keysOf(keymap.move), run: () => setMoving(true) },
      { label: t('Enlazar con…'), run: onLink },
      { label: note.archivedAt ? t('Desarchivar') : t('Archivar'), title: t('Se oculta con lo que cuelga de ella'), keys: keysOf(keymap.archive), run: onArchive },
      { label: t('Borrar'), danger: true, run: () => close(() => onDelete(note.id)) },
    ];
    const tools = (
      <>
        <button className="reader-icon" onClick={openMenu} aria-haspopup="menu" aria-expanded={!!menu} aria-label={t('Más acciones')} title={t('Más acciones')}>
          <DotsIcon />
        </button>
        <button className="reader-icon reader-fold" onClick={toggleFolded} aria-label={folded ? t('Mostrar los detalles') : t('Plegar los detalles')} title={`${folded ? t('Mostrar los detalles') : t('Plegar los detalles')} (${keysOf(keymap.details)})`}>
          <PanelIcon />
        </button>
      </>
    );
    return (
      <div ref={ref} className={`sheet is-reader${zen ? ' is-zen' : ''}${wide ? ' is-wide' : ''}${folded ? ' is-side-folded' : ''}`} style={{ '--reader-w': `${sideWidth.width}px` } as CSSProperties}>
        {zenExit}
        <div className="reader-main">
          <article className="reader-body" key={note.id + note.kind}>
            <span className="reader-meta">
              {madre ? madre.title || t('Nota sin título') : t('Arriba del todo')} · {kindOf(note, kids)} · {t('editada {date}', { date: editedLabel(note.updatedAt) })}
              {source && ' · Markdown'}
            </span>
            <SheetEditor note={note} onSave={onSave} onError={onError} editorRef={editorRef} wiki={wiki} source={source} />
            <NoteChips note={note} defs={defs} onOpen={() => onProps(note.id)} />
          </article>
        </div>
        {/* Los botones de la nota van en la barra de arriba, a la altura de los de la barra lateral;
            sin barra, flotan arriba a la derecha. */}
        {barSlot ? createPortal(<div className="reader-tools reader-bar-tools">{tools}</div>, barSlot) : <div className="reader-float">{tools}</div>}
        <input
          ref={filePick}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            const ed = editorRef.current;
            if (files.length && ed) attachFiles(ed.view, files, onError);
          }}
        />
        {!folded && <Resizer size={sideWidth} edge="left" className="reader-resizer" />}
        {!folded && (
          <aside className="reader-side" aria-label={t('Detalles de la nota')}>
            <div className="reader-side-top">
              <span className="reader-side-h">{t('Detalles')}</span>
            </div>
            <dl className="reader-facts">
              <dt>{t('Tipo')}</dt>
              <dd>{kindOf(note, kids)}</dd>
              <dt>{t('Madre')}</dt>
              <dd>
                <button className="reader-madre" onClick={() => setMoving(true)} title={t('Mover dentro de otra nota')}>
                  {madre ? madre.title || t('Nota sin título') : t('Arriba del todo')}
                </button>
              </dd>
              {kids > 0 && (
                <>
                  <dt>{t('Dentro')}</dt>
                  <dd>{tn(kids, '{n} nota', '{n} notas')}</dd>
                </>
              )}
              <dt>{t('Creada')}</dt>
              <dd>{created}</dd>
              <dt>{t('Editada')}</dt>
              <dd>{editedLabel(note.updatedAt)}</dd>
              <dt>{t('Palabras')}</dt>
              <dd>{words}</dd>
              {tasks.total > 0 && (
                <>
                  <dt>{t('Tareas')}</dt>
                  <dd>{tasks.done === tasks.total ? tn(tasks.total, '{n} hecha', '{n} hechas') : t('{done} de {total} hechas', { done: tasks.done, total: tasks.total })}</dd>
                </>
              )}
            </dl>
            {kids > 0 && (
              <>
                <div className="reader-rule" />
                <div className="reader-side-row">
                  <span className="reader-side-h">{t('Dentro')}</span>
                  <span className="reader-muted">{kids}</span>
                </div>
                <div className="reader-links">
                  {inside.slice(0, MAX_LINKS).map(({ r, n }) => (
                    <span key={r.id} className="reader-link">
                      <button className="reader-link-go" onClick={() => onNavigate(r.id)}>
                        <span className="reader-link-g" aria-hidden="true">
                          {n ? '▸' : '·'}
                        </span>
                        <span className="reader-ellipsis">{r.kind === 'canvas' ? r.title || t('Canvas sin título') : r.title || t('Nota sin título')}</span>
                        {n > 0 && <span className="reader-muted reader-link-n">{n}</span>}
                      </button>
                    </span>
                  ))}
                  {kids > MAX_LINKS && <span className="reader-muted">{t('+{n} más', { n: kids - MAX_LINKS })}</span>}
                </div>
              </>
            )}
            <div className="reader-rule" />
            <div className="reader-side-row">
              <span className="reader-side-h">{t('Enlaces')}</span>
              <span className="reader-muted">{neighbors.length}</span>
            </div>
            <div className="reader-links">
              {shown.map((n) => (
                <span key={n.id} className="reader-link">
                  <button className="reader-link-go" onClick={() => onNavigate(n.id)}>
                    <span className="reader-link-g" aria-hidden="true">
                      ·
                    </span>
                    <span className="reader-ellipsis">{n.title || t('Nota sin título')}</span>
                  </button>
                  <button className="reader-link-x" onClick={() => onUnlink(n.id)} aria-label={t('Quitar el enlace con {name}', { name: n.title || t('esta nota') })} title={t('Quitar enlace')}>
                    ×
                  </button>
                </span>
              ))}
              {neighbors.length > MAX_LINKS && <span className="reader-muted">{t('+{n} más', { n: neighbors.length - MAX_LINKS })}</span>}
              <button className="reader-add" onClick={onLink}>
                {t('＋ Enlazar')}
              </button>
            </div>
          </aside>
        )}
        {menu && <SheetMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
        {picker}
      </div>
    );
  }

  return (
    <div ref={ref} className={`sheet is-canvas${zen ? ' is-zen' : ''}`}>
      {zenExit}
      {/* Sin «Volver» ni título: el lienzo ocupa todo y el nombre se cambia en la ruta de arriba. */}
      <header className="sheet-top meta">
        <button className="reader-icon" onClick={openMenu} aria-haspopup="menu" aria-expanded={!!menu} aria-label={t('Más acciones')} title={t('Más acciones')}>
          <DotsIcon />
        </button>
      </header>
      <div className="sheet-canvas" key={note.id + note.kind}>
        <CanvasBoard
          note={note}
          rows={rows}
          onSave={(c) => onSave(note.id, { ...c, title: note.title })}
          onOpenNote={onNavigate}
          onPickNote={onPickNote}
          onError={onError}
        />
      </div>
      {menu && (
        <SheetMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: t('Ver en nodos'), title: t('Este canvas en el centro, con sus relaciones'), keys: keysOf(keymap.nodes), run: onNodes },
            { label: t('Modo zen'), title: t('Quitar toda la interfaz y quedarse solo con el canvas (Esc para salir)'), keys: keysOf(keymap.zen), run: () => setZen(true) },
            null,
            { label: t('Mover a…'), title: t('Meterlo dentro de otra nota'), keys: keysOf(keymap.move), run: () => setMoving(true) },
            { label: t('Propiedades'), run: () => onProps(note.id) },
            { label: note.archivedAt ? t('Desarchivar') : t('Archivar'), title: t('Se oculta con lo que cuelga de él'), keys: keysOf(keymap.archive), run: onArchive },
            { label: t('Borrar'), danger: true, run: () => close(() => onDelete(note.id)) },
          ]}
          onClose={closeMenu}
        />
      )}
      {picker}
    </div>
  );
}
