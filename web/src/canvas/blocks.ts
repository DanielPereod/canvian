import { Extension, Mark, Node, mergeAttributes, wrappingInputRule, type Editor } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { t } from '../i18n';
import './blocks.css';

// Los bloques de Notion que no trae el editor de serie: columnas, avisos con
// icono, desplegables y colores; y lo que se hace con un bloque entero
// (moverlo, duplicarlo, convertirlo en otro, pintarlo).

// ── Colores ───────────────────────────────────────────────────────────
// Un bloque puede llevar color de letra («blue») o de fondo («blue-bg»), y un
// trozo de texto también. Son nombres, no valores: cada tema los pinta.
export const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type ColorName = (typeof COLORS)[number];
const COLOR_NAMES: Record<ColorName, string> = {
  gray: 'Gris',
  brown: 'Marrón',
  orange: 'Naranja',
  yellow: 'Amarillo',
  green: 'Verde',
  blue: 'Azul',
  purple: 'Morado',
  pink: 'Rosa',
  red: 'Rojo',
};
export const colorName = (c: ColorName) => t(COLOR_NAMES[c]);

const COLORED = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'callout', 'toggle'];

export const BlockColor = Extension.create({
  name: 'blockColor',
  addGlobalAttributes: () => [
    {
      types: COLORED,
      attributes: {
        color: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-color'),
          renderHTML: (a) => (a.color ? { 'data-color': a.color } : {}),
        },
      },
    },
  ],
});

export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes: () => ({
    color: { default: null, parseHTML: (el) => el.getAttribute('data-text-color'), renderHTML: (a) => ({ 'data-text-color': a.color }) },
  }),
  parseHTML: () => [{ tag: 'span[data-text-color]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

// ── Columnas ──────────────────────────────────────────────────────────
// Unas columnas son una fila de columnas, y cada columna, bloques normales.
export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'note-column' }), 0],
});

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'note-columns' }), 0],
});

// ── Aviso: un recuadro con un icono ──────────────────────────────────
export const CALLOUT_ICONS = ['💡', '📌', '⚠️', '✅', '❗', '❓', '📝', '🔥', '💬', '⭐'];

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    icon: { default: '💡', parseHTML: (el) => el.getAttribute('data-icon') || '💡', renderHTML: (a) => ({ 'data-icon': a.icon }) },
  }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'note-callout' }),
    ['span', { class: 'note-callout-icon', contenteditable: 'false' }, String(node.attrs.icon)],
    ['div', { class: 'note-callout-body' }, 0],
  ],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'note-callout';
      dom.dataset.callout = '';
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'note-callout-icon';
      icon.contentEditable = 'false';
      icon.title = t('Cambiar el icono');
      const body = document.createElement('div');
      body.className = 'note-callout-body';
      dom.append(icon, body);
      const paint = (n: PMNode) => {
        icon.textContent = String(n.attrs.icon);
        if (n.attrs.color) dom.dataset.color = String(n.attrs.color);
        else delete dom.dataset.color;
      };
      paint(node);
      // Un toque cambia al siguiente icono de la lista.
      icon.addEventListener('mousedown', (e) => e.preventDefault());
      icon.addEventListener('click', () => {
        const pos = getPos();
        if (typeof pos !== 'number' || !editor.isEditable) return;
        const i = CALLOUT_ICONS.indexOf(String(current.attrs.icon));
        const next = CALLOUT_ICONS[(i + 1) % CALLOUT_ICONS.length];
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, icon: next }));
      });
      return {
        dom,
        contentDOM: body,
        update: (n) => {
          if (n.type !== current.type) return false;
          current = n;
          paint(n);
          return true;
        },
        stopEvent: (e) => e.target === icon,
        ignoreMutation: (m) => m.target === icon || (m.type !== 'selection' && !body.contains(m.target)),
      };
    };
  },
});

// ── Desplegable: la primera línea siempre se ve; el resto, al abrirlo ─
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes: () => ({
    open: { default: true, parseHTML: (el) => el.getAttribute('data-open') !== 'false', renderHTML: (a) => ({ 'data-open': a.open ? 'true' : 'false' }) },
  }),
  parseHTML: () => [{ tag: 'div[data-toggle]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'note-toggle' }), ['div', { class: 'note-toggle-body' }, 0]],
  // «>> » al principio de una línea (con «> » sale una cita).
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>>\s$/, type: this.type })];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'note-toggle';
      dom.dataset.toggle = '';
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'note-toggle-arrow';
      arrow.contentEditable = 'false';
      const body = document.createElement('div');
      body.className = 'note-toggle-body';
      dom.append(arrow, body);
      const paint = (n: PMNode) => {
        dom.dataset.open = n.attrs.open ? 'true' : 'false';
        arrow.setAttribute('aria-expanded', n.attrs.open ? 'true' : 'false');
        arrow.setAttribute('aria-label', n.attrs.open ? t('Plegar') : t('Desplegar'));
        if (n.attrs.color) dom.dataset.color = String(n.attrs.color);
        else delete dom.dataset.color;
      };
      paint(node);
      arrow.addEventListener('mousedown', (e) => e.preventDefault());
      arrow.addEventListener('click', () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        // Abrir o cerrar no es escribir: no entra en deshacer.
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, open: !current.attrs.open }).setMeta('addToHistory', false));
      });
      return {
        dom,
        contentDOM: body,
        update: (n) => {
          if (n.type !== current.type) return false;
          current = n;
          paint(n);
          return true;
        },
        stopEvent: (e) => e.target === arrow,
        ignoreMutation: (m) => m.target === arrow || (m.type !== 'selection' && !body.contains(m.target)),
      };
    };
  },
});

// ── Bloques ───────────────────────────────────────────────────────────
// Un «bloque» es lo que se arrastra con el asa: un párrafo, un encabezado,
// un punto de una lista, una imagen, un aviso, unas columnas… Lo que hay
// dentro de una columna, un aviso o un desplegable también lo es.
export type Block = { pos: number; node: PMNode };

const CONTAINERS = new Set(['doc', 'column', 'callout', 'toggle', 'bulletList', 'orderedList', 'taskList']);
// La primera línea de un desplegable va con él: es su título.
const holds = (parent: PMNode, index: number) => CONTAINERS.has(parent.type.name) && !(parent.type.name === 'toggle' && index === 0);

export function blockAt(doc: PMNode, pos: number): Block | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  // Lo que empieza justo aquí (una imagen, una raya) cuenta primero.
  const after = $p.nodeAfter;
  if (after?.isBlock && holds($p.parent, $p.index())) return { pos: $p.pos, node: after };
  for (let d = $p.depth; d > 0; d--) {
    if (holds($p.node(d - 1), $p.index(d - 1))) return { pos: $p.before(d), node: $p.node(d) };
  }
  return null;
}

export const selectedBlock = (state: EditorState) => blockAt(state.doc, state.selection.from);

// Pone el cursor dentro del bloque (en su primera línea de texto).
function caretIn(tr: Transaction, pos: number) {
  const $p = tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size));
  return tr.setSelection(Selection.near($p));
}

export function moveBlock(view: EditorView, block: Block, dir: -1 | 1) {
  const { state } = view;
  const $p = state.doc.resolve(block.pos);
  const index = $p.index();
  const parent = $p.parent;
  const other = dir < 0 ? index - 1 : index + 1;
  if (other < 0 || other >= parent.childCount) return false;
  const sibling = parent.child(other);
  const offset = state.selection.from - block.pos;
  const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize);
  const at = dir < 0 ? block.pos - sibling.nodeSize : block.pos + sibling.nodeSize;
  tr.insert(at, block.node);
  const inside = Math.min(at + Math.max(offset, 1), at + block.node.nodeSize - 1);
  tr.setSelection(Selection.near(tr.doc.resolve(inside)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function duplicateBlock(view: EditorView, block: Block) {
  const end = block.pos + block.node.nodeSize;
  const tr = view.state.tr.insert(end, block.node.copy(block.node.content));
  view.dispatch(caretIn(tr, end).scrollIntoView());
  return true;
}

export function deleteBlock(view: EditorView, block: Block) {
  const { state } = view;
  const $p = state.doc.resolve(block.pos);
  const tr = state.tr;
  // El único bloque de una columna se lleva la columna; el único de la nota
  // (o de un aviso) deja una línea en blanco.
  if ($p.parent.childCount === 1) {
    if ($p.parent.type.name === 'column') tr.delete($p.before(), $p.after());
    else tr.replaceWith(block.pos, block.pos + block.node.nodeSize, state.schema.nodes.paragraph.create());
  } else tr.delete(block.pos, block.pos + block.node.nodeSize);
  view.dispatch(caretIn(tr, Math.min(block.pos, tr.doc.content.size - 1)).scrollIntoView());
  view.focus();
  return true;
}

export function colorBlock(view: EditorView, block: Block, color: string | null) {
  if (!COLORED.includes(block.node.type.name)) return false;
  view.dispatch(view.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, color }));
  return true;
}

// ── Convertir en ──────────────────────────────────────────────────────
export type Kind = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'toggle' | 'quote' | 'callout' | 'code';

export const KINDS: { kind: Kind; label: string; icon: string; md?: string }[] = [
  { kind: 'text', label: 'Texto', icon: 'Aa' },
  { kind: 'h1', label: 'Encabezado 1', icon: 'H1', md: '#' },
  { kind: 'h2', label: 'Encabezado 2', icon: 'H2', md: '##' },
  { kind: 'h3', label: 'Encabezado 3', icon: 'H3', md: '###' },
  { kind: 'bullet', label: 'Lista con viñetas', icon: '•', md: '-' },
  { kind: 'ordered', label: 'Lista numerada', icon: '1.', md: '1.' },
  { kind: 'task', label: 'Lista de tareas', icon: '☐', md: '[]' },
  { kind: 'toggle', label: 'Desplegable', icon: '▸', md: '>>' },
  { kind: 'quote', label: 'Cita', icon: '❝', md: '>' },
  { kind: 'callout', label: 'Aviso', icon: '💡' },
  { kind: 'code', label: 'Código', icon: '</>', md: '```' },
];

export function kindOf(state: EditorState): Kind | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    const name = n.type.name;
    if (name === 'callout') return 'callout';
    if (name === 'toggle') return 'toggle';
    if (name === 'blockquote') return 'quote';
    if (name === 'taskList') return 'task';
    if (name === 'orderedList') return 'ordered';
    if (name === 'bulletList') return 'bullet';
  }
  const p = $from.parent;
  if (p.type.name === 'heading') return (['h1', 'h2', 'h3'] as const)[Math.min(Number(p.attrs.level), 3) - 1];
  if (p.type.name === 'codeBlock') return 'code';
  return p.type.name === 'paragraph' ? 'text' : null;
}

// Lo que se hace con la línea del cursor (desde «/» o la barra).
export function applyKind(editor: Editor, kind: Kind) {
  const c = () => editor.chain().focus();
  switch (kind) {
    case 'text':
      return c().setParagraph().run();
    case 'h1':
    case 'h2':
    case 'h3':
      return c().setHeading({ level: Number(kind[1]) as 1 | 2 | 3 }).run();
    case 'bullet':
      return c().toggleBulletList().run();
    case 'ordered':
      return c().toggleOrderedList().run();
    case 'task':
      return c().toggleTaskList().run();
    case 'quote':
      return c().setParagraph().wrapIn('blockquote').run();
    case 'callout':
      return c().setParagraph().wrapIn('callout').run();
    case 'toggle':
      return c().setParagraph().wrapIn('toggle').run();
    case 'code':
      return c().setCodeBlock().run();
  }
}

const WRAPPERS = new Set(['callout', 'toggle', 'blockquote']);
const ITEMS = new Set(['listItem', 'taskItem']);

export const canTurn = (block: Block) => block.node.isTextblock || WRAPPERS.has(block.node.type.name) || ITEMS.has(block.node.type.name);

// Un bloque entero en otro tipo: primero se deja en una línea normal (fuera
// de su aviso, su lista…) y luego se le da la forma nueva.
export function turnBlock(editor: Editor, block: Block, kind: Kind) {
  const { view } = editor;
  const name = block.node.type.name;
  if (WRAPPERS.has(name)) {
    const tr = view.state.tr.replaceWith(block.pos, block.pos + block.node.nodeSize, block.node.content);
    view.dispatch(caretIn(tr, block.pos));
  } else if (ITEMS.has(name)) {
    view.dispatch(caretIn(view.state.tr, block.pos));
    editor.commands.liftListItem(name);
  } else view.dispatch(caretIn(view.state.tr, block.pos));
  if (kind === 'text' && !block.node.isTextblock) return editor.chain().focus().setParagraph().run();
  // Volver a pulsar el tipo que ya tenía la lista la quitaría: aquí ya se quitó.
  return applyKind(editor, kind);
}

// ── Insertar ──────────────────────────────────────────────────────────
// Columnas vacías donde está el cursor (en la línea si está vacía, o debajo).
export function insertColumns(editor: Editor, n: number) {
  const { state, view } = editor;
  const { schema } = state;
  const { $from } = state.selection;
  const cols = schema.nodes.columns.create(
    null,
    Array.from({ length: n }, () => schema.nodes.column.create(null, schema.nodes.paragraph.create())),
  );
  // Siempre en lo alto de la nota: unas columnas no van dentro de otras.
  const top = $from.depth ? $from.before(1) : 0;
  const node = $from.depth ? $from.node(1) : null;
  const tr = state.tr;
  let at: number;
  if (node && node.isTextblock && node.content.size === 0) {
    tr.replaceWith(top, top + node.nodeSize, cols);
    at = top;
  } else {
    at = node ? top + node.nodeSize : 0;
    tr.insert(at, cols);
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 3));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

// Una tabla de 3 × 3 con fila de encabezado, en la línea del cursor si está
// vacía o debajo de ella (el comando del editor falla con la línea a medias).
export function insertTable(editor: Editor) {
  const { state, view } = editor;
  const { schema } = state;
  const { $from } = state.selection;
  const { table, tableRow, tableHeader, tableCell } = schema.nodes;
  const row = (cell: typeof tableCell) => tableRow.create(null, [0, 1, 2].map(() => cell.createAndFill()!));
  const node = table.create(null, [row(tableHeader), row(tableCell), row(tableCell)]);
  const tr = state.tr;
  let at: number;
  if ($from.parent.isTextblock && $from.depth > 0) {
    const d = $from.depth;
    if ($from.parent.content.size === 0) {
      at = $from.before(d);
      tr.replaceWith(at, $from.after(d), node);
    } else {
      at = $from.after(d);
      tr.insert(at, node);
    }
  } else {
    at = state.selection.to;
    tr.insert(at, node);
  }
  // El cursor, en la primera celda.
  tr.setSelection(Selection.near(tr.doc.resolve(at + 4)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

// ── Arrastrar a un lado: columnas ─────────────────────────────────────
// Soltar un bloque junto al borde derecho de otro (o a su izquierda, en el
// margen) los pone en dos columnas; junto a una columna, añade otra.
export type SideDrop = { pos: number; kind: 'block' | 'column'; dir: 'left' | 'right'; rect: DOMRect };

// El asa avisa de que el arrastre es suyo (y qué bloque lleva).
export const dragState: { block: Block | null } = { block: null };

export function sideDropAt(view: EditorView, x: number, y: number): SideDrop | null {
  const dragged = dragState.block;
  if (!dragged || dragged.node.type.name === 'columns') return null;
  const box = view.dom.getBoundingClientRect();
  const hit = view.posAtCoords({ left: Math.max(box.left + 4, Math.min(x, box.right - 4)), top: y });
  if (!hit) return null;
  const b = blockAt(view.state.doc, hit.inside >= 0 ? hit.inside : hit.pos);
  if (!b) return null;
  const $b = view.state.doc.resolve(b.pos);
  // Dentro de una columna se mira la columna; si no, solo lo de arriba del todo.
  let target: { pos: number; node: PMNode; kind: 'block' | 'column' } | null = null;
  for (let d = $b.depth; d >= 0; d--) {
    if ($b.node(d).type.name === 'column') {
      target = { pos: $b.before(d), node: $b.node(d), kind: 'column' };
      break;
    }
  }
  if (!target && $b.depth === 0) target = { ...b, kind: 'block' };
  if (!target) return null;
  if (target.kind === 'block' && target.node.type.name === 'columns') return null;
  // No junto a sí mismo, ni dentro de lo que se arrastra.
  const from = dragged.pos;
  const to = from + dragged.node.nodeSize;
  if (target.pos >= from && target.pos < to) return null;
  if (target.kind === 'block' && target.pos === from) return null;
  const dom = view.nodeDOM(target.pos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  if (y < rect.top || y > rect.bottom) return null;
  const right = x > rect.left + rect.width * 0.8;
  const left = target.kind === 'column' ? x < rect.left + Math.min(24, rect.width * 0.12) : x < rect.left;
  if (!right && !left) return null;
  return { pos: target.pos, kind: target.kind, dir: right ? 'right' : 'left', rect };
}

function dropToSide(view: EditorView, drop: SideDrop) {
  const dragged = dragState.block;
  if (!dragged) return false;
  const { state } = view;
  const { schema } = state;
  const $d = state.doc.resolve(dragged.pos);
  // Un punto de una lista se lleva su lista alrededor.
  let node = dragged.node;
  if (!node.type.spec.group?.split(' ').includes('block')) node = $d.parent.type.create($d.parent.attrs, node);
  const tr = state.tr;
  if ($d.parent.type.name === 'column' && $d.parent.childCount === 1) tr.delete($d.before(), $d.after());
  else tr.delete(dragged.pos, dragged.pos + dragged.node.nodeSize);
  const at = tr.mapping.map(drop.pos, 1);
  const target = tr.doc.nodeAt(at);
  if (!target) return false;
  const col = (n: PMNode) => schema.nodes.column.create(null, n);
  let caret: number;
  if (drop.kind === 'column') {
    if (target.type.name !== 'column') return false;
    caret = drop.dir === 'left' ? at : at + target.nodeSize;
    tr.insert(caret, col(node));
  } else {
    const pair = drop.dir === 'left' ? [col(node), col(target)] : [col(target), col(node)];
    tr.replaceWith(at, at + target.nodeSize, schema.nodes.columns.create(null, pair));
    caret = drop.dir === 'left' ? at + 1 : at + 1 + pair[0].nodeSize;
  }
  view.dispatch(caretIn(tr, caret + 1).setMeta('uiEvent', 'drop'));
  return true;
}

let indicator: HTMLDivElement | null = null;
function showIndicator(drop: SideDrop | null) {
  document.body.classList.toggle('is-col-drop', !!drop);
  if (!drop) {
    indicator?.remove();
    indicator = null;
    return;
  }
  indicator ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'note-col-indicator' }));
  const x = drop.dir === 'right' ? drop.rect.right + 6 : drop.rect.left - 8;
  Object.assign(indicator.style, { left: `${x}px`, top: `${drop.rect.top}px`, height: `${drop.rect.height}px` });
}

// Arreglos tras cada cambio: unas columnas con una sola columna dejan de
// serlo, y al sacar algo arrastrando de una columna, la que queda vacía se va.
const tidyKey = new PluginKey('blockTidy');
function tidy(state: EditorState, dropped: boolean): Transaction | null {
  const fixes: { pos: number; node: PMNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'columns') return true;
    fixes.push({ pos, node });
    return false;
  });
  if (!fixes.length) return null;
  const tr = state.tr;
  for (const { pos, node } of fixes.reverse()) {
    let kept: PMNode[] = [];
    node.forEach((c) => {
      const empty = c.childCount === 1 && c.firstChild!.isTextblock && c.firstChild!.content.size === 0;
      if (!(dropped && empty)) kept.push(c);
    });
    if (kept.length === node.childCount && kept.length > 1) continue;
    if (!kept.length) kept = [node.firstChild!];
    if (kept.length === 1) tr.replaceWith(pos, pos + node.nodeSize, kept[0].content);
    else tr.replaceWith(pos, pos + node.nodeSize, node.type.create(node.attrs, Fragment.from(kept)));
  }
  return tr.docChanged ? tr : null;
}

const exitable = new Set(['callout', 'toggle']);

export const BlockKit = Extension.create({
  name: 'blockKit',
  addKeyboardShortcuts() {
    const run = (fn: (view: EditorView, b: Block) => boolean) => () => {
      const b = selectedBlock(this.editor.state);
      return !!b && fn(this.editor.view, b);
    };
    return {
      'Mod-d': run(duplicateBlock),
      'Mod-Shift-ArrowUp': run((v, b) => moveBlock(v, b, -1)),
      'Mod-Shift-ArrowDown': run((v, b) => moveBlock(v, b, 1)),
      // Intro en una línea vacía al final de un aviso o desplegable sale de él.
      Enter: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.depth < 2 || $from.parent.content.size || !$from.parent.isTextblock) return false;
        const box = $from.node(-1);
        if (!exitable.has(box.type.name) || $from.index(-1) !== box.childCount - 1 || box.childCount < 2) return false;
        const after = $from.after(-1);
        const tr = state.tr.delete($from.before(), $from.after());
        const at = tr.mapping.map(after);
        tr.insert(at, state.schema.nodes.paragraph.create());
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
        return true;
      },
      // Borrar al principio de un aviso o desplegable lo deshace (queda el texto).
      Backspace: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
        const box = $from.node(-1);
        if (!exitable.has(box.type.name) || $from.index(-1) !== 0) return false;
        const pos = $from.before(-1);
        const tr = state.tr.replaceWith(pos, pos + box.nodeSize, box.content);
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tidyKey,
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((tr) => tr.docChanged)) return null;
          return tidy(state, trs.some((tr) => tr.getMeta('uiEvent') === 'drop'));
        },
        props: {
          handleDOMEvents: {
            dragover: (view, e) => {
              showIndicator(dragState.block ? sideDropAt(view, e.clientX, e.clientY) : null);
              return false;
            },
            dragleave: (view, e) => {
              if (!view.dom.contains(e.relatedTarget as globalThis.Node | null)) showIndicator(null);
              return false;
            },
          },
          handleDrop: (view, e) => {
            const drop = dragState.block ? sideDropAt(view, e.clientX, e.clientY) : null;
            showIndicator(null);
            if (!drop) return false;
            e.preventDefault();
            (view as unknown as { dragging: unknown }).dragging = null;
            return dropToSide(view, drop);
          },
        },
      }),
    ];
  },
});

export const endDrag = () => {
  dragState.block = null;
  showIndicator(null);
};

// Para quien lo necesite fuera (el asa): seleccionar un bloque entero.
export const selectBlock = (view: EditorView, block: Block) => view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, block.pos)));

export const blockNodes = [Columns, Column, Callout, Toggle, BlockColor, TextColor];
