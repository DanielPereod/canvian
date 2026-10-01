import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { t } from '../i18n';
import { attachFiles } from './media';
import { TOUCH } from './touch';
import type { SlashQuery } from './slash';
import { promptLink } from './editor';
import {
  COLORS,
  KINDS,
  applyKind,
  blockAt,
  canTurn,
  colorBlock,
  colorName,
  deleteBlock,
  dragState,
  duplicateBlock,
  endDrag,
  insertColumns,
  kindOf,
  moveBlock,
  turnBlock,
  type Block,
  type Kind,
} from './blocks';

// Lo que rodea al texto para escribir como en Notion: el menú «/», el asa de
// cada bloque (arrastrar y su menú), la barra de formato al seleccionar y, en
// el móvil, una barra encima del teclado.

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Que un toque en los menús no le quite el foco al texto (ni cierre el teclado).
const keep = (e: { preventDefault: () => void }) => e.preventDefault();

// Vuelve a pintar con cada cambio del editor.
function useEditorTick(editor: Editor) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on('transaction', tick);
    editor.on('focus', tick);
    editor.on('blur', tick);
    return () => {
      editor.off('transaction', tick);
      editor.off('focus', tick);
      editor.off('blur', tick);
    };
  }, [editor]);
}

function pickFiles(accept: string, then: (files: File[]) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (accept) input.accept = accept;
  input.onchange = () => then([...(input.files ?? [])]);
  input.click();
}

const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

// ── Menú «/» ──────────────────────────────────────────────────────────
type SlashItem = { id: string; label: string; icon: string; group: string; words: string; hint?: string; run: (editor: Editor, onError: (e: unknown) => void) => void };

const KIND_WORDS: Record<Kind, string> = {
  text: 'parrafo plain paragraph normal',
  h1: 'titulo heading title h1 grande big',
  h2: 'subtitulo heading h2 mediano',
  h3: 'heading h3 pequeno small',
  bullet: 'puntos vinetas bullet unordered ul lista list',
  ordered: 'numeros numbered ordered ol lista list',
  task: 'todo tareas casillas checkbox check to-do lista list',
  toggle: 'toggle plegable desplegable collapse fold details acordeon',
  quote: 'quote blockquote cita',
  callout: 'callout aviso nota destacado recuadro info note tip',
  code: 'code codigo snippet pre programa',
};

function slashItems(editor: Editor): SlashItem[] {
  const items: SlashItem[] = KINDS.map((k) => ({
    id: k.kind,
    label: k.label,
    icon: k.icon,
    group: k.kind === 'code' ? 'Otros' : 'Bloques básicos',
    words: KIND_WORDS[k.kind],
    hint: k.md,
    run: (ed) => void applyKind(ed, k.kind),
  }));
  items.splice(
    items.findIndex((i) => i.id === 'code'),
    0,
    {
      id: 'divider',
      label: 'Separador',
      icon: '—',
      group: 'Bloques básicos',
      words: 'divider separador linea raya hr rule',
      hint: '---',
      run: (ed) => void ed.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'table',
      label: 'Tabla',
      icon: '▦',
      group: 'Bloques básicos',
      words: 'table tabla grid filas columnas',
      run: (ed) => void ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
  );
  items.push(
    { id: 'col2', label: '2 columnas', icon: '▥', group: 'Diseño', words: 'columns columnas 2 dos two layout', run: (ed) => void insertColumns(ed, 2) },
    { id: 'col3', label: '3 columnas', icon: '▥', group: 'Diseño', words: 'columns columnas 3 tres three layout', run: (ed) => void insertColumns(ed, 3) },
    { id: 'col4', label: '4 columnas', icon: '▥', group: 'Diseño', words: 'columns columnas 4 cuatro four layout', run: (ed) => void insertColumns(ed, 4) },
    {
      id: 'image',
      label: 'Imagen',
      icon: '🖼',
      group: 'Medios',
      words: 'image imagen foto picture photo img',
      run: (ed, onError) => pickFiles('image/*', (files) => files.length && attachFiles(ed.view, files, onError)),
    },
    {
      id: 'file',
      label: 'Archivo',
      icon: '📎',
      group: 'Medios',
      words: 'file archivo adjunto attach pdf video audio documento upload subir',
      run: (ed, onError) => pickFiles('', (files) => files.length && attachFiles(ed.view, files, onError)),
    },
  );
  if (editor.schema.nodes.youtube)
    items.push({
      id: 'youtube',
      label: 'Vídeo de YouTube',
      icon: '▶',
      group: 'Medios',
      words: 'youtube video embed incrustar',
      run: (ed) => {
        const src = window.prompt(t('Enlace del vídeo de YouTube'), 'https://')?.trim();
        if (!src || src === 'https://') return void ed.commands.focus();
        ed.chain().focus().insertContent({ type: 'youtube', attrs: { src } }).run();
      },
    });
  items.push(
    { id: 'wiki', label: 'Enlace a una nota', icon: '↗', group: 'Enlaces', words: 'link nota page enlace wiki mention mencion [[', hint: '[[', run: (ed) => void ed.chain().focus().insertContent('[[').run() },
    { id: 'link', label: 'Enlace web', icon: '🔗', group: 'Enlaces', words: 'link url web enlace bookmark', hint: `${MOD} K`, run: (ed) => promptLink(ed) },
    { id: 'date', label: 'Fecha de hoy', icon: '📅', group: 'Otros', words: 'date fecha hoy today dia', run: (ed) => void ed.chain().focus().insertContent(today()).run() },
  );
  return items;
}

const GROUP_ORDER = ['Bloques básicos', 'Diseño', 'Medios', 'Enlaces', 'Otros'];

function filterItems(all: SlashItem[], query: string) {
  const q = norm(query.trim());
  if (!q) return [...all].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const words = q.split(/\s+/);
  const hits: { item: SlashItem; score: number }[] = [];
  for (const item of all) {
    const label = norm(`${item.label} ${t(item.label)}`);
    const hay = `${label} ${item.words}`;
    if (!words.every((w) => hay.includes(w))) continue;
    hits.push({ item, score: label.split(/\s+/).some((w) => w.startsWith(words[0])) ? 0 : 1 });
  }
  return hits.sort((a, b) => a.score - b.score).map((h) => h.item);
}

// Debajo del cursor, o encima si no cabe (en el móvil, el teclado se come la mitad).
function placeNear(q: { left: number; top: number; bottom: number }, height: number, width: number): CSSProperties {
  const vv = window.visualViewport;
  const viewTop = vv?.offsetTop ?? 0;
  const viewH = vv?.height ?? window.innerHeight;
  const below = q.bottom + height + 12 < viewTop + viewH || q.top - height - 12 < viewTop;
  return {
    left: Math.max(8, Math.min(q.left, window.innerWidth - width - 8)),
    ...(below ? { top: q.bottom + 6 } : { bottom: window.innerHeight - q.top + 6 }),
  };
}

type SlashProps = { query: SlashQuery; editor: Editor; onError: (e: unknown) => void; keys: { current: (e: KeyboardEvent) => boolean } };

export function SlashMenu({ query, editor, onError, keys }: SlashProps) {
  const all = useMemo(() => slashItems(editor), [editor]);
  const items = useMemo(() => filterItems(all, query.query), [all, query.query]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [query.query]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (item: SlashItem) => {
    editor.chain().focus().deleteRange({ from: query.from, to: query.to }).run();
    item.run(editor, onError);
  };

  keys.current = (e) => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => (c + step + items.length) % items.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      pick(items[Math.min(cursor, items.length - 1)]);
      return true;
    }
    return false;
  };

  // Sin nada que case, la lista se va (y lo escrito se queda como texto).
  if (!items.length) return null;
  const grouped = !query.query.trim();
  return createPortal(
    <div ref={list} className="slash-menu" style={placeNear(query, 340, 300)} role="listbox" aria-label={t('Bloques')} onMouseDown={keep}>
      {items.map((item, i) => (
        <div key={item.id}>
          {grouped && (i === 0 || items[i - 1].group !== item.group) && <div className="slash-group">{t(item.group)}</div>}
          <button
            role="option"
            aria-selected={i === cursor}
            className="slash-item"
            onMouseEnter={() => !TOUCH && setCursor(i)}
            onClick={() => pick(item)}
          >
            <span className="slash-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="slash-label">{t(item.label)}</span>
            {item.hint && <span className="slash-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ── Menú del bloque (asa, o «Bloque» en el móvil) ─────────────────────
type MenuProps = { editor: Editor; block: Block; at: { x: number; y: number }; onClose: () => void; above?: boolean };

export function BlockMenu({ editor, block, at, onClose, above }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: at.x, top: at.y, visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
    const top = above ? at.y - r.height - 8 : Math.min(at.y, bottom - r.height - 8);
    setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), top: Math.max(8, top) });
  }, [at.x, at.y, above]);
  useEffect(() => {
    const down = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        editor.commands.focus();
      }
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [editor, onClose]);

  // El bloque tal como está ahora (pudo cambiar mientras el menú estaba abierto).
  const live = () => {
    const b = blockAt(editor.state.doc, block.pos);
    return b && b.pos === block.pos && b.node.type === block.node.type ? b : null;
  };
  const act = (fn: (b: Block) => unknown) => () => {
    const b = live();
    onClose();
    if (b) fn(b);
  };
  const view = editor.view;
  const color = (block.node.attrs.color as string | null) ?? null;
  const colorable = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'callout', 'toggle'].includes(block.node.type.name);
  const current = (() => {
    if (!canTurn(block)) return null;
    const name = block.node.type.name;
    if (name === 'callout') return 'callout';
    if (name === 'toggle') return 'toggle';
    if (name === 'blockquote') return 'quote';
    if (name === 'taskItem') return 'task';
    if (name === 'listItem') return editor.state.doc.resolve(block.pos).parent.type.name === 'orderedList' ? 'ordered' : 'bullet';
    if (name === 'heading') return `h${Math.min(3, Number(block.node.attrs.level))}`;
    if (name === 'codeBlock') return 'code';
    return 'text';
  })();

  return createPortal(
    <div ref={ref} className="bib-menu blk-menu" style={pos} role="menu" aria-label={t('Bloque')} onMouseDown={keep} onContextMenu={keep}>
      {canTurn(block) && (
        <>
          <div className="bib-menu-head">{t('Convertir en')}</div>
          <div className="blk-kinds">
            {KINDS.map((k) => (
              <button key={k.kind} role="menuitemradio" aria-checked={current === k.kind} className={`blk-kind${current === k.kind ? ' is-on' : ''}`} onClick={act((b) => current !== k.kind && turnBlock(editor, b, k.kind))}>
                <span className="blk-kind-i" aria-hidden="true">
                  {k.icon}
                </span>
                {t(k.label)}
              </button>
            ))}
          </div>
          <div className="bib-menu-sep" role="separator" />
        </>
      )}
      {colorable && (
        <>
          <div className="bib-menu-head">{t('Color')}</div>
          <div className="blk-colors">
            <button className={`blk-color is-default${!color ? ' is-on' : ''}`} title={t('Por defecto')} aria-label={t('Por defecto')} onClick={act((b) => colorBlock(view, b, null))}>
              A
            </button>
            {COLORS.map((c) => (
              <button key={c} className={`blk-color${color === c ? ' is-on' : ''}`} data-swatch={c} title={colorName(c)} aria-label={colorName(c)} onClick={act((b) => colorBlock(view, b, c))}>
                A
              </button>
            ))}
          </div>
          <div className="blk-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`blk-color is-bg${color === `${c}-bg` ? ' is-on' : ''}`}
                data-swatch={`${c}-bg`}
                title={t('Fondo {color}', { color: colorName(c).toLowerCase() })}
                aria-label={t('Fondo {color}', { color: colorName(c).toLowerCase() })}
                onClick={act((b) => colorBlock(view, b, `${c}-bg`))}
              />
            ))}
          </div>
          <div className="bib-menu-sep" role="separator" />
        </>
      )}
      <MenuItem onClick={act((b) => duplicateBlock(view, b))} keys={`${MOD} D`}>
        {t('Duplicar')}
      </MenuItem>
      <MenuItem onClick={act((b) => moveBlock(view, b, -1))} keys={`${MOD} ⇧ ↑`}>
        {t('Mover arriba')}
      </MenuItem>
      <MenuItem onClick={act((b) => moveBlock(view, b, 1))} keys={`${MOD} ⇧ ↓`}>
        {t('Mover abajo')}
      </MenuItem>
      <MenuItem danger onClick={act((b) => deleteBlock(view, b))} keys={TOUCH ? undefined : t('Supr')}>
        {t('Eliminar')}
      </MenuItem>
    </div>,
    document.body,
  );
}

function MenuItem({ children, onClick, keys, danger }: { children: ReactNode; onClick: () => void; keys?: string; danger?: boolean }) {
  return (
    <button role="menuitem" className={`bib-menu-it${danger ? ' is-danger' : ''}`} onClick={onClick}>
      {children}
      {keys && !TOUCH && <span className="bib-menu-k">{keys}</span>}
    </button>
  );
}

// ── El asa de cada bloque (ordenador) ─────────────────────────────────
type Spot = { block: Block; left: number; top: number; box: { top: number; bottom: number; left: number } };

export function BlockHandle({ editor }: { editor: Editor }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [menu, setMenu] = useState<{ block: Block; at: { x: number; y: number } } | null>(null);
  const spotRef = useRef(spot);
  spotRef.current = spot;

  useEffect(() => {
    if (TOUCH) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const update = () => {
      raf = 0;
      const view = editor.view;
      if (!editor.isEditable || dragState.block || !view.dom.isConnected) return;
      // Yendo del bloque hacia su asa (a la izquierda, a su altura) no se
      // cambia de bloque, aunque se pase por encima de la columna de al lado.
      const now0 = spotRef.current;
      if (now0 && y >= now0.box.top && y <= now0.box.bottom && x >= now0.left - 4 && x <= now0.box.left + 4) return;
      const box = view.dom.getBoundingClientRect();
      if (x < box.left - 72 || x > box.right + 24 || y < box.top - 4 || y > box.bottom + 4) return setSpot(null);
      const hit = view.posAtCoords({ left: Math.max(box.left + 2, Math.min(x, box.right - 2)), top: y });
      const b = hit && blockAt(view.state.doc, hit.inside >= 0 ? hit.inside : hit.pos);
      const dom = b && view.nodeDOM(b.pos);
      if (!b || !(dom instanceof HTMLElement)) return setSpot(null);
      const r = dom.getBoundingClientRect();
      const style = getComputedStyle(dom);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 24;
      const top = r.top + Math.min(r.height, line) / 2 - 12 + (b.node.type.name === 'callout' ? 10 : 0);
      const left = r.left - 50;
      const now = spotRef.current;
      if (now && now.block.pos === b.pos && now.block.node === b.node && Math.abs(now.top - top) < 1 && Math.abs(now.left - left) < 1) return;
      setSpot({ block: b, left, top, box: { top: r.top, bottom: r.bottom, left: r.left } });
    };
    const move = (e: MouseEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!raf) raf = requestAnimationFrame(update);
    };
    // Al escribir o desplazar, se esconde hasta que se mueva el ratón.
    const hide = () => setSpot(null);
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('scroll', hide, true);
    editor.view.dom.addEventListener('keydown', hide);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('scroll', hide, true);
      editor.view.dom.removeEventListener('keydown', hide);
    };
  }, [editor]);

  if (TOUCH) return null;

  const dragStart = (e: DragEvent) => {
    const s = spotRef.current;
    if (!s) return;
    const view = editor.view;
    const sel = NodeSelection.create(view.state.doc, s.block.pos);
    view.dispatch(view.state.tr.setSelection(sel));
    const slice = sel.content();
    const { dom, text } = view.serializeForClipboard(slice);
    e.dataTransfer.clearData();
    e.dataTransfer.setData('text/html', dom.innerHTML);
    e.dataTransfer.setData('text/plain', text);
    e.dataTransfer.effectAllowed = 'copyMove';
    const el = view.nodeDOM(s.block.pos);
    if (el instanceof HTMLElement) e.dataTransfer.setDragImage(el, 0, 0);
    (view as unknown as { dragging: unknown }).dragging = { slice, move: true, node: sel };
    dragState.block = s.block;
    setMenu(null);
  };
  const dragEnd = () => {
    endDrag();
    setSpot(null);
    const view = editor.view as unknown as { dragging: unknown };
    setTimeout(() => (view.dragging = null), 50);
  };
  const openMenu = (e: React.MouseEvent) => {
    const s = spotRef.current;
    if (!s) return;
    const view = editor.view;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, s.block.pos)));
    view.focus();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ block: s.block, at: { x: r.left, y: r.bottom + 4 } });
  };
  // «+»: una línea nueva debajo, con el menú «/» ya abierto.
  const addBelow = () => {
    const s = spotRef.current;
    if (!s) return;
    const view = editor.view;
    const { state } = view;
    const b = s.block;
    const p = state.schema.nodes.paragraph;
    const tr = state.tr;
    let at: number;
    if (b.node.isTextblock && b.node.content.size === 0) {
      tr.insertText('/', b.pos + 1);
      at = b.pos + 2;
    } else if (b.node.type.name === 'listItem' || b.node.type.name === 'taskItem') {
      const end = b.pos + b.node.nodeSize;
      tr.insert(end, b.node.type.create(null, p.create(null, state.schema.text('/'))));
      at = end + 3;
    } else {
      const end = b.pos + b.node.nodeSize;
      tr.insert(end, p.create(null, state.schema.text('/')));
      at = end + 2;
    }
    view.focus();
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView());
  };

  return (
    <>
      {spot &&
        createPortal(
          <div className="blk-handle" style={{ left: spot.left, top: spot.top }}>
            {/* Sin quitarle el foco al texto; el asa no, o no se podría arrastrar. */}
            <button className="blk-btn" onMouseDown={keep} onClick={addBelow} title={t('Añadir un bloque debajo')} aria-label={t('Añadir un bloque debajo')}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button className="blk-btn blk-grip" draggable onDragStart={dragStart} onDragEnd={dragEnd} onClick={openMenu} title={t('Arrastra para mover · pulsa para el menú')} aria-label={t('Menú del bloque')}>
              <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
                {[2, 7, 12].flatMap((cy) => [<circle key={`a${cy}`} cx="2.5" cy={cy} r="1.3" fill="currentColor" />, <circle key={`b${cy}`} cx="7.5" cy={cy} r="1.3" fill="currentColor" />])}
              </svg>
            </button>
          </div>,
          document.body,
        )}
      {menu && <BlockMenu editor={editor} block={menu.block} at={menu.at} onClose={() => setMenu(null)} />}
    </>
  );
}

// ── Barra de formato al seleccionar texto (ordenador) ────────────────
export function FormatBar({ editor }: { editor: Editor }) {
  useEditorTick(editor);
  const [pressed, setPressed] = useState(false);
  const [open, setOpen] = useState<'turn' | 'color' | null>(null);
  useEffect(() => {
    if (TOUCH) return;
    const down = () => setPressed(true);
    const up = () => setPressed(false);
    editor.view.dom.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      editor.view.dom.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, [editor]);
  const { state, view } = editor;
  const sel = state.selection;
  const show = !TOUCH && !pressed && editor.isFocused && sel instanceof TextSelection && !sel.empty && !sel.$from.parent.type.spec.code;
  useEffect(() => {
    if (!show) setOpen(null);
  }, [show]);
  if (!show) return null;
  const a = view.coordsAtPos(sel.from);
  const b = view.coordsAtPos(sel.to);
  const top = Math.min(a.top, b.top);
  const style: CSSProperties = {
    left: Math.max(8, Math.min((a.left + b.right) / 2 - 170, window.innerWidth - 348)),
    ...(top > 60 ? { bottom: window.innerHeight - top + 8 } : { top: Math.max(a.bottom, b.bottom) + 8 }),
  };
  const kind = kindOf(state);
  const mark = (name: string, run: () => boolean, label: string, glyph: ReactNode, keys: string) => (
    <button className={`fmt-btn${editor.isActive(name) ? ' is-on' : ''}`} onClick={run} title={`${label} (${keys})`} aria-label={label} aria-pressed={editor.isActive(name)}>
      {glyph}
    </button>
  );
  const textColor = editor.getAttributes('textColor').color as string | undefined;
  return createPortal(
    <div className="fmt-bar" style={style} onMouseDown={keep} role="toolbar" aria-label={t('Formato')}>
      <button className="fmt-btn fmt-turn" onClick={() => setOpen(open === 'turn' ? null : 'turn')} aria-expanded={open === 'turn'}>
        {t(KINDS.find((k) => k.kind === kind)?.label ?? 'Texto')} <span aria-hidden="true">▾</span>
      </button>
      <span className="fmt-sep" />
      {mark('bold', () => editor.chain().focus().toggleBold().run(), t('Negrita'), <b>B</b>, `${MOD} B`)}
      {mark('italic', () => editor.chain().focus().toggleItalic().run(), t('Cursiva'), <i>I</i>, `${MOD} I`)}
      {mark('underline', () => editor.chain().focus().toggleUnderline().run(), t('Subrayado'), <u>U</u>, `${MOD} U`)}
      {mark('strike', () => editor.chain().focus().toggleStrike().run(), t('Tachado'), <s>S</s>, `${MOD} ⇧ S`)}
      {mark('code', () => editor.chain().focus().toggleCode().run(), t('Código'), <code>{'</>'}</code>, '`')}
      {mark('link', () => (promptLink(editor), true), t('Enlace'), '🔗', `${MOD} K`)}
      <span className="fmt-sep" />
      <button className="fmt-btn" onClick={() => setOpen(open === 'color' ? null : 'color')} aria-expanded={open === 'color'} title={t('Color')} aria-label={t('Color')}>
        <span className="fmt-a" data-text-color={textColor}>
          A
        </span>{' '}
        <span aria-hidden="true">▾</span>
      </button>
      {open === 'turn' && (
        <div className="fmt-drop" role="menu">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              role="menuitemradio"
              aria-checked={kind === k.kind}
              className={`bib-menu-it${kind === k.kind ? ' is-on' : ''}`}
              onClick={() => {
                setOpen(null);
                if (kind !== k.kind) applyKind(editor, k.kind);
              }}
            >
              <span className="blk-kind-i" aria-hidden="true">
                {k.icon}
              </span>
              {t(k.label)}
            </button>
          ))}
        </div>
      )}
      {open === 'color' && (
        <div className="fmt-drop fmt-colors" role="menu">
          <div className="bib-menu-head">{t('Color del texto')}</div>
          <div className="blk-colors">
            <button className={`blk-color is-default${!textColor ? ' is-on' : ''}`} title={t('Por defecto')} onClick={() => editor.chain().focus().unsetMark('textColor').run()}>
              A
            </button>
            {COLORS.map((c) => (
              <button key={c} className={`blk-color${textColor === c ? ' is-on' : ''}`} data-swatch={c} title={colorName(c)} onClick={() => editor.chain().focus().setMark('textColor', { color: c }).run()}>
                A
              </button>
            ))}
          </div>
          <div className="bib-menu-head">{t('Fondo')}</div>
          <div className="blk-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`blk-color is-bg${textColor === `${c}-bg` ? ' is-on' : ''}`}
                data-swatch={`${c}-bg`}
                title={t('Fondo {color}', { color: colorName(c).toLowerCase() })}
                onClick={() => editor.chain().focus().setMark('textColor', { color: `${c}-bg` }).run()}
              />
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── Barra del móvil, encima del teclado ──────────────────────────────
export function MobileBar({ editor }: { editor: Editor }) {
  useEditorTick(editor);
  const [menu, setMenu] = useState<{ block: Block; at: { x: number; y: number } } | null>(null);
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!TOUCH || !vv) return;
    const fit = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
    };
  }, []);
  const bar = useRef<HTMLDivElement>(null);
  if (!TOUCH || (!editor.isFocused && !menu)) return null;
  const c = () => editor.chain().focus();
  const inList = editor.isActive('listItem') || editor.isActive('taskItem');
  const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
  // «/» donde está el cursor: sale el menú de bloques.
  const slash = () => {
    const { $from } = editor.state.selection;
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
    c().insertContent(before && !/\s/.test(before) ? ' /' : '/').run();
  };
  const blockMenu = () => {
    const b = blockAt(editor.state.doc, editor.state.selection.from);
    const r = bar.current?.getBoundingClientRect();
    if (b && r) setMenu({ block: b, at: { x: 8, y: r.top } });
  };
  const btn = (label: string, glyph: ReactNode, run: () => unknown, on = false, disabled = false) => (
    <button className={`mbar-btn${on ? ' is-on' : ''}`} onMouseDown={keep} onClick={() => void run()} aria-label={label} title={label} aria-pressed={on} disabled={disabled}>
      {glyph}
    </button>
  );
  return createPortal(
    <>
      <div ref={bar} className="mbar" style={{ bottom: inset }} role="toolbar" aria-label={t('Formato')}>
        {btn(t('Añadir un bloque'), '+', slash)}
        {btn(t('Menú del bloque'), '⋮⋮', blockMenu, !!menu)}
        {btn(t('Negrita'), <b>B</b>, () => c().toggleBold().run(), editor.isActive('bold'))}
        {btn(t('Cursiva'), <i>I</i>, () => c().toggleItalic().run(), editor.isActive('italic'))}
        {btn(t('Lista de tareas'), '☐', () => c().toggleTaskList().run(), editor.isActive('taskList'))}
        {btn(t('Sangrar'), '⇥', () => c().sinkListItem(item).run(), false, !inList)}
        {btn(t('Quitar sangría'), '⇤', () => c().liftListItem(item).run(), false, !inList)}
        {btn(t('Enlace'), '🔗', () => promptLink(editor), editor.isActive('link'))}
        {btn(t('Deshacer'), '↶', () => c().undo().run(), false, !editor.can().undo())}
        {btn(t('Cerrar el teclado'), '⌄', () => editor.commands.blur())}
      </div>
      {menu && <BlockMenu editor={editor} block={menu.block} at={menu.at} above onClose={() => setMenu(null)} />}
    </>,
    document.body,
  );
}
