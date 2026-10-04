import { Extension, Mark, Node, mergeAttributes, wrappingInputRule, type Editor } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { t } from '../i18n';
import { newBlockId } from '../../../server/src/doc/json';
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

// ── Id de bloque: para enlazar a un punto exacto de la nota ──────────
// Solo lo tienen los bloques a los que se ha copiado un enlace. No pasa al
// partir la línea con Intro, y si un bloque se duplica o se pega otra vez, la
// copia se queda sin él: el enlace sigue llevando al de antes.
const WITH_ID = [...COLORED.filter((n) => !n.endsWith('List')), 'codeBlock', 'table', 'columns', 'horizontalRule', 'image', 'video', 'audio', 'youtube', 'bookmark', 'noteEmbed', 'file'];

export const BlockId = Extension.create({
  name: 'blockId',
  addGlobalAttributes: () => [
    {
      types: WITH_ID,
      attributes: {
        blockId: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el) => el.getAttribute('data-block-id'),
          renderHTML: (a) => (a.blockId ? { 'data-block-id': a.blockId } : {}),
        },
      },
    },
  ],
  addProseMirrorPlugins() {
    return [
      // El resaltado del bloque al que lleva un enlace (una clase puesta a mano
      // la quitaría el editor al repintar).
      new Plugin({
        key: flashKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set: DecorationSet) => {
            const meta = tr.getMeta(flashKey) as number | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (typeof meta === 'number') {
              const node = tr.doc.nodeAt(meta);
              return node ? DecorationSet.create(tr.doc, [Decoration.node(meta, meta + node.nodeSize, { class: 'is-flash-block' })]) : set;
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => flashKey.getState(state) },
      }),
      new Plugin({
        key: new PluginKey('blockIdUnique'),
        appendTransaction: (trs, old, state) => {
          if (!trs.some((tr) => tr.docChanged)) return null;
          const seen = new Map<string, number[]>();
          state.doc.descendants((node, pos) => {
            const id = node.attrs.blockId as string | null | undefined;
            if (id) seen.set(id, [...(seen.get(id) ?? []), pos]);
          });
          const twice = [...seen].filter(([, at]) => at.length > 1);
          if (!twice.length) return null;
          // Se queda con el id el bloque que ya lo tenía (donde haya ido a parar).
          const before = new Map<string, number>();
          old.doc.descendants((node, pos) => {
            const id = node.attrs.blockId as string | null | undefined;
            if (id && !before.has(id)) before.set(id, pos);
          });
          const tr = state.tr;
          for (const [id, at] of twice) {
            let keep = before.has(id) ? trs.reduce((p, x) => x.mapping.map(p), before.get(id)!) : at[0];
            if (!at.includes(keep)) keep = at[0];
            for (const pos of at) if (pos !== keep) tr.setNodeAttribute(pos, 'blockId', null);
          }
          return tr.setMeta('addToHistory', false);
        },
      }),
    ];
  },
});

const flashKey = new PluginKey<DecorationSet>('blockFlash');

// El id del bloque, poniéndole uno si aún no tiene. null si ese bloque no puede llevarlo.
export function ensureBlockId(view: EditorView, block: Block): string | null {
  const node = view.state.doc.nodeAt(block.pos);
  if (!node || !('blockId' in node.attrs)) return null;
  const had = node.attrs.blockId as string | null;
  if (had) return had;
  const id = newBlockId();
  view.dispatch(view.state.tr.setNodeAttribute(block.pos, 'blockId', id));
  return id;
}

// Dónde está «#sección» en el documento: el bloque con ese id («^abc123») o el
// encabezado con ese texto.
export function findAnchor(doc: PMNode, section: string): number | null {
  const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const id = section.startsWith('^') ? section.slice(1) : null;
  const want = fold(section);
  let at: number | null = null;
  doc.descendants((node, pos) => {
    if (at !== null) return false;
    if (id ? node.attrs.blockId === id : node.type.name === 'heading' && fold(node.textContent) === want) at = pos;
    return at === null;
  });
  return at;
}

// El primer bloque con texto en el que sale `query` (lo buscado en Ctrl P).
export function findText(doc: PMNode, query: string): number | null {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Mejor donde salen todas las palabras; si no, donde salga alguna.
  let all: number | null = null;
  let some: number | null = null;
  doc.descendants((node, pos) => {
    if (all !== null) return false;
    if (!node.isTextblock) return true;
    const text = fold(node.textContent);
    if (words.every((w) => text.includes(w))) all = pos;
    else if (some === null && words.some((w) => text.includes(w))) some = pos;
    return false;
  });
  return all ?? some;
}

// Lleva hasta el bloque, deja el cursor en él y lo resalta un momento.
export function flashAt(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return;
  const $in = view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size));
  view.dispatch(view.state.tr.setSelection(Selection.near($in)).setMeta(flashKey, pos).setMeta('addToHistory', false));
  view.focus();
  dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(flashKey, null).setMeta('addToHistory', false)), 2400);
}

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

// ── Aviso: un recuadro con cabecera (icono + tipo), como en Obsidian ──
// El tipo sale del icono guardado: así las notas de siempre no cambian.
export const CALLOUT_ICONS = ['💡', '📌', '⚠️', '✅', '❗', '❓', '📝', '🔥', '💬', '⭐'];

const SVG = (d: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const CALLOUT_KINDS: Record<string, { kind: string; label: string; svg: string }> = {
  '💡': { kind: 'note', label: 'Nota', svg: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>') },
  '📌': { kind: 'example', label: 'Ejemplo', svg: SVG('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>') },
  '⚠️': { kind: 'warning', label: 'Atención', svg: SVG('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>') },
  '✅': { kind: 'success', label: 'Hecho', svg: SVG('<path d="M20 6 9 17l-5-5"/>') },
  '❗': { kind: 'danger', label: 'Peligro', svg: SVG('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>') },
  '❓': { kind: 'question', label: 'Pregunta', svg: SVG('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>') },
  '📝': { kind: 'abstract', label: 'Resumen', svg: SVG('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>') },
  '🔥': { kind: 'tip', label: 'Consejo', svg: SVG('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.4.3 1.6 1.4 2.9 2.5 2.9Z"/>') },
  '💬': { kind: 'quote', label: 'Cita', svg: SVG('<path d="M3 21c3 0 7-1 7-8V5c0-1.3-.8-2-2-2H4c-1.3 0-2 .8-2 2v6c0 1.3.8 2 2 2h1c0 2.5-.5 4-2 5M15 21c3 0 7-1 7-8V5c0-1.3-.8-2-2-2h-4c-1.3 0-2 .8-2 2v6c0 1.3.8 2 2 2h1c0 2.5-.5 4-2 5"/>') },
  '⭐': { kind: 'star', label: 'Destacado', svg: SVG('<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1Z"/>') },
};
const calloutKind = (icon: unknown) => CALLOUT_KINDS[String(icon)];

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    icon: { default: '💡', parseHTML: (el) => el.getAttribute('data-icon') || '💡', renderHTML: (a) => ({ 'data-icon': a.icon }) },
  }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const k = calloutKind(node.attrs.icon);
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'note-callout', 'data-kind': k?.kind ?? 'custom' }),
      ['span', { class: 'note-callout-head', contenteditable: 'false' }, k ? t(k.label) : String(node.attrs.icon)],
      ['div', { class: 'note-callout-body' }, 0],
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'note-callout';
      dom.dataset.callout = '';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'note-callout-head';
      head.contentEditable = 'false';
      head.title = t('Cambiar el tipo');
      const icon = document.createElement('span');
      icon.className = 'note-callout-icon';
      const label = document.createElement('span');
      label.className = 'note-callout-label';
      head.append(icon, label);
      const body = document.createElement('div');
      body.className = 'note-callout-body';
      dom.append(head, body);
      const paint = (n: PMNode) => {
        const k = calloutKind(n.attrs.icon);
        dom.dataset.kind = k?.kind ?? 'custom';
        // Un icono que no es de la lista (de un aviso importado) se ve tal cual.
        if (k) icon.innerHTML = k.svg;
        else icon.textContent = String(n.attrs.icon);
        label.textContent = k ? t(k.label) : t('Aviso');
        if (n.attrs.color) dom.dataset.color = String(n.attrs.color);
        else delete dom.dataset.color;
      };
      paint(node);
      // Un toque en la cabecera pasa al siguiente tipo.
      head.addEventListener('mousedown', (e) => e.preventDefault());
      head.addEventListener('click', () => {
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
        stopEvent: (e) => head.contains(e.target as globalThis.Node),
        ignoreMutation: (m) => head.contains(m.target) || (m.type !== 'selection' && !body.contains(m.target)),
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

// Pone el cursor dentro del bloque (en su primera línea de texto).
function caretIn(tr: Transaction, pos: number) {
  const $p = tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size));
  return tr.setSelection(Selection.near($p));
}

// ── Varios bloques a la vez ───────────────────────────────────────────
// Si lo seleccionado abarca varios bloques, el asa, las teclas y los menús
// actúan sobre todos: son los bloques seguidos (hermanos) que toca, dentro
// de lo que los contiene a todos (la nota, una columna, una lista…).
const blockSelKey = new PluginKey<{ from: number; to: number } | null>('blockSel');
export const blockSelOf = (state: EditorState) => blockSelKey.getState(state) ?? null;

const endOf = (run: Block[]) => run[run.length - 1].pos + run[run.length - 1].node.nodeSize;

// Los bloques hermanos que hay entre dos posiciones de su contenedor.
function runIn(doc: PMNode, from: number, to: number): Block[] {
  if (from < 0 || to > doc.content.size || from >= to) return [];
  const $f = doc.resolve(from);
  const parent = $f.parent;
  const run: Block[] = [];
  let pos = from;
  for (let i = $f.index(); i < parent.childCount && pos < to; i++) {
    const node = parent.child(i);
    run.push({ pos, node });
    pos += node.nodeSize;
  }
  return pos === to ? run : [];
}

export function selectedBlocks(state: EditorState): Block[] {
  const bs = blockSelOf(state);
  if (bs) {
    const run = runIn(state.doc, bs.from, bs.to);
    if (run.length) return run;
  }
  const { selection: sel, doc } = state;
  if (sel.empty || sel instanceof NodeSelection) {
    const one = blockAt(doc, sel.from);
    return one ? [one] : [];
  }
  return blocksBetween(doc, sel.from, sel.to);
}

// Los bloques que toca lo que va de una posición a otra.
function blocksBetween(doc: PMNode, from: number, to: number): Block[] {
  const one = blockAt(doc, from);
  if (!one || to <= from) return one ? [one] : [];
  const $from = doc.resolve(from);
  // Acabar al principio de una línea no la cuenta (al seleccionar con ⇧ ↓).
  let $to = doc.resolve(to);
  if ($to.parentOffset === 0 && $to.parent.inlineContent && $to.depth > 0) $to = doc.resolve($to.before());
  for (let d = $from.sharedDepth($to.pos); d >= 0; d--) {
    const parent = $from.node(d);
    if (!CONTAINERS.has(parent.type.name)) continue;
    const a = $from.index(d);
    const b = $to.depth > d ? $to.index(d) : $to.index(d) - 1;
    if (parent.type.name === 'toggle' && a === 0 && b > a) continue;
    if (b <= a) return [one];
    return runIn(doc, $from.posAtIndex(a, d), $from.posAtIndex(b + 1, d));
  }
  return [one];
}

// Deja señalados varios bloques: se resaltan enteros y lo de después va con todos.
function selectRun(tr: Transaction, from: number, to: number) {
  tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(to)));
  return tr.setMeta(blockSelKey, { from, to });
}
export const selectBlocks = (view: EditorView, run: Block[]) => {
  if (!run.length) return;
  if (run.length === 1) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, run[0].pos)));
  else view.dispatch(selectRun(view.state.tr, run[0].pos, endOf(run)));
};

// Lo que se quita al sacar unos bloques: si son todo lo de una columna o una
// lista, se va la columna o la lista con ellos.
const GOES_WITH = new Set(['column', 'bulletList', 'orderedList', 'taskList']);
function outerRange(doc: PMNode, run: Block[]) {
  let from = run[0].pos;
  let to = endOf(run);
  let $p = doc.resolve(from);
  while ($p.depth > 0 && from === $p.start() && to === $p.end() && GOES_WITH.has($p.parent.type.name)) {
    from = $p.before();
    to = $p.after();
    $p = doc.resolve(from);
  }
  return { from, to, whole: from === $p.start() && to === $p.end() };
}

export function moveBlocks(view: EditorView, run: Block[], dir: -1 | 1) {
  if (!run.length) return false;
  const { state } = view;
  const from = run[0].pos;
  const to = endOf(run);
  const $p = state.doc.resolve(from);
  const parent = $p.parent;
  const first = $p.index();
  const other = dir < 0 ? first - 1 : first + run.length;
  if (other < 0 || other >= parent.childCount) return false;
  const delta = (dir < 0 ? -1 : 1) * parent.child(other).nodeSize;
  const sel = state.selection;
  const tr = state.tr.delete(from, to);
  tr.insert(from + delta, Fragment.fromArray(run.map((b) => b.node)));
  if (run.length > 1) selectRun(tr, from + delta, to + delta);
  else if (sel instanceof NodeSelection && sel.from === from) tr.setSelection(NodeSelection.create(tr.doc, from + delta));
  else {
    const offset = sel.from - from;
    const at = from + delta;
    const inside = Math.min(at + Math.max(offset, 1), at + run[0].node.nodeSize - 1);
    tr.setSelection(Selection.near(tr.doc.resolve(inside)));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function duplicateBlocks(view: EditorView, run: Block[]) {
  if (!run.length) return false;
  const end = endOf(run);
  const copies = run.map(({ node }) => node.type.create({ ...node.attrs, ...(node.attrs.blockId ? { blockId: null } : {}) }, node.content, node.marks));
  const tr = view.state.tr.insert(end, Fragment.fromArray(copies));
  if (run.length > 1) selectRun(tr, end, end + (end - run[0].pos));
  else caretIn(tr, end);
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function deleteBlocks(view: EditorView, run: Block[]) {
  if (!run.length) return false;
  const { state } = view;
  const { from, to, whole } = outerRange(state.doc, run);
  const tr = state.tr;
  // Lo único de la nota (o de un aviso) deja una línea en blanco.
  if (whole) tr.replaceWith(from, to, state.schema.nodes.paragraph.create());
  else tr.delete(from, to);
  view.dispatch(caretIn(tr, Math.min(from, tr.doc.content.size - 1)).scrollIntoView());
  view.focus();
  return true;
}

export function colorBlocks(view: EditorView, run: Block[], color: string | null) {
  const tr = view.state.tr;
  for (const b of run) if (COLORED.includes(b.node.type.name)) tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, color });
  if (!tr.docChanged) return false;
  const bs = blockSelOf(view.state);
  if (bs) tr.setMeta(blockSelKey, bs);
  view.dispatch(tr);
  return true;
}

export const moveBlock = (view: EditorView, block: Block, dir: -1 | 1) => moveBlocks(view, [block], dir);
export const duplicateBlock = (view: EditorView, block: Block) => duplicateBlocks(view, [block]);
export const deleteBlock = (view: EditorView, block: Block) => deleteBlocks(view, [block]);
export const colorBlock = (view: EditorView, block: Block, color: string | null) => colorBlocks(view, [block], color);

// Los bloques del menú tal como están ahora (pudieron cambiar con él abierto).
export function liveBlocks(doc: PMNode, run: Block[]): Block[] | null {
  if (!run.length) return null;
  const now = run.length === 1 ? [blockAt(doc, run[0].pos)] : runIn(doc, run[0].pos, endOf(run));
  if (now.length !== run.length) return null;
  return now.every((b, i) => b && b.pos === run[i].pos && b.node.type === run[i].node.type) ? (now as Block[]) : null;
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

// Varias líneas a la vez: se seleccionan todas y se les da la forma juntas.
export const canTurnAll = (run: Block[]) => (run.length === 1 ? canTurn(run[0]) : run.length > 1 && run.every((b) => b.node.isTextblock));
export function turnBlocks(editor: Editor, run: Block[], kind: Kind) {
  if (run.length === 1) return turnBlock(editor, run[0], kind);
  const { view } = editor;
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(run[0].pos), doc.resolve(endOf(run)))));
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

// El asa avisa de que el arrastre es suyo (y qué bloques lleva).
export const dragState: { blocks: Block[] | null } = { blocks: null };

export function sideDropAt(view: EditorView, x: number, y: number): SideDrop | null {
  const run = dragState.blocks;
  if (!run?.length || run.some((b) => b.node.type.name === 'columns')) return null;
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
  const from = run[0].pos;
  const to = endOf(run);
  if (target.pos >= from && target.pos < to) return null;
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
  const run = dragState.blocks;
  if (!run?.length) return false;
  const { state } = view;
  const { schema } = state;
  const $d = state.doc.resolve(run[0].pos);
  // Los puntos de una lista se llevan su lista alrededor.
  let nodes = run.map((b) => b.node);
  if (!nodes[0].type.spec.group?.split(' ').includes('block')) nodes = [$d.parent.type.create($d.parent.attrs, nodes)];
  const tr = state.tr;
  const out = outerRange(state.doc, run);
  tr.delete(out.from, out.to);
  const at = tr.mapping.map(drop.pos, 1);
  const target = tr.doc.nodeAt(at);
  if (!target) return false;
  const col = (n: PMNode[]) => schema.nodes.column.create(null, n);
  let start: number;
  let caret: number;
  if (drop.kind === 'column') {
    if (target.type.name !== 'column') return false;
    caret = drop.dir === 'left' ? at : at + target.nodeSize;
    tr.insert(caret, col(nodes));
    start = caret + 1;
  } else {
    const pair = drop.dir === 'left' ? [col(nodes), col([target])] : [col([target]), col(nodes)];
    tr.replaceWith(at, at + target.nodeSize, schema.nodes.columns.create(null, pair));
    caret = drop.dir === 'left' ? at + 1 : at + 1 + pair[0].nodeSize;
    start = caret + 1;
  }
  if (nodes.length > 1) selectRun(tr, start, start + nodes.reduce((n, c) => n + c.nodeSize, 0));
  else caretIn(tr, caret + 1);
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
  return true;
}

// Varios bloques soltados entre otros: se quitan de donde estaban y se ponen
// juntos donde cae la raya, como uno solo.
function dropRun(view: EditorView, e: DragEvent) {
  const run = dragState.blocks;
  const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
  if (!run || run.length < 2 || !hit) return false;
  const { state } = view;
  const from = run[0].pos;
  const to = endOf(run);
  const slice = state.doc.slice(from, to);
  const at = dropPoint(state.doc, hit.pos, slice) ?? hit.pos;
  if (at >= from && at <= to) return true;
  const tr = state.tr;
  const out = outerRange(state.doc, run);
  tr.delete(out.from, out.to);
  const pos = tr.mapping.map(at);
  tr.replaceRange(pos, pos, slice);
  let end = pos;
  tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_f, _t, _nf, newTo) => (end = newTo));
  // Lo puesto, señalado.
  const run2 = blocksBetween(tr.doc, pos, end);
  if (run2.length > 1) selectRun(tr, run2[0].pos, endOf(run2));
  else tr.setSelection(TextSelection.between(tr.doc.resolve(pos), tr.doc.resolve(end)));
  view.focus();
  view.dispatch(tr.setMeta('uiEvent', 'drop'));
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
    const run = (fn: (view: EditorView, run: Block[]) => boolean) => () => {
      const bs = selectedBlocks(this.editor.state);
      return !!bs.length && fn(this.editor.view, bs);
    };
    return {
      'Mod-d': run(duplicateBlocks),
      'Mod-Shift-ArrowUp': run((v, bs) => moveBlocks(v, bs, -1)),
      'Mod-Shift-ArrowDown': run((v, bs) => moveBlocks(v, bs, 1)),
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
              showIndicator(dragState.blocks ? sideDropAt(view, e.clientX, e.clientY) : null);
              return false;
            },
            dragleave: (view, e) => {
              if (!view.dom.contains(e.relatedTarget as globalThis.Node | null)) showIndicator(null);
              return false;
            },
          },
          handleDrop: (view, e) => {
            const drop = dragState.blocks ? sideDropAt(view, e.clientX, e.clientY) : null;
            showIndicator(null);
            if (!drop && !((dragState.blocks?.length ?? 0) > 1)) return false;
            e.preventDefault();
            (view as unknown as { dragging: unknown }).dragging = null;
            return drop ? dropToSide(view, drop) : dropRun(view, e);
          },
        },
      }),
    ];
  },
});

export const endDrag = () => {
  dragState.blocks = null;
  showIndicator(null);
};

// Los bloques señalados se resaltan enteros (sin el subrayado del texto), y
// mientras lo están, borrar los quita y Esc los suelta. Cualquier otro
// cambio de selección o de texto deja de señalarlos.
export const BlockSelection = Extension.create({
  name: 'blockSelection',
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin<{ from: number; to: number } | null>({
        key: blockSelKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(blockSelKey) as { from: number; to: number } | null | undefined;
            if (meta !== undefined) return meta;
            if (!value) return null;
            if (tr.getMeta('appendedTransaction') && tr.docChanged) {
              const from = tr.mapping.map(value.from, 1);
              const to = tr.mapping.map(value.to, -1);
              return from < to ? { from, to } : null;
            }
            return tr.docChanged || tr.selectionSet ? null : value;
          },
        },
        props: {
          attributes: (state): Record<string, string> => (blockSelKey.getState(state) ? { class: 'has-block-sel' } : {}),
          decorations: (state) => {
            if (!blockSelKey.getState(state)) return null;
            const run = selectedBlocks(state);
            return DecorationSet.create(
              state.doc,
              run.map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: 'is-block-sel' })),
            );
          },
          handleKeyDown: (view, e) => {
            if (!blockSelKey.getState(view.state)) return false;
            if (e.key === 'Backspace' || e.key === 'Delete') {
              e.preventDefault();
              return deleteBlocks(view, selectedBlocks(view.state));
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              view.dispatch(view.state.tr.setMeta(blockSelKey, null));
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export const blockNodes = [Columns, Column, Callout, Toggle, BlockColor, BlockId, TextColor];
