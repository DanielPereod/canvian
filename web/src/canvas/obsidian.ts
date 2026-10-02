import { Extension, InputRule, Mark, Node, markInputRule, markPasteRule, mergeAttributes } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { TaskItem, TaskList } from '@tiptap/extension-list';

// El Markdown de Obsidian que no trae el editor de serie: [[enlaces]] entre
// notas, ==resaltado==, casillas de tareas y [texto](url) al escribir.

export type WikiAttrs = { id: string | null; target: string; alias: string | null };

// «Nota#Sección|alias» → sus partes. La nota es lo que se busca.
export function splitWiki(raw: string): { note: string; section: string | null; alias: string | null } {
  const bar = raw.indexOf('|');
  const target = bar < 0 ? raw : raw.slice(0, bar);
  const alias = bar < 0 ? null : raw.slice(bar + 1).trim() || null;
  const hash = target.indexOf('#');
  return {
    note: (hash < 0 ? target : target.slice(0, hash)).trim(),
    section: hash < 0 ? null : target.slice(hash + 1).trim() || null,
    alias,
  };
}

export const wikiLabel = (a: { target: string; alias: string | null }) => a.alias || a.target;

// [[Nota]]: un enlace a otra nota. Guarda el id de la nota (si se sabe) y el
// texto tal cual se escribió, para poder encontrarla por título si no.
export const WikiLink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => el.getAttribute('data-id'), renderHTML: (a) => (a.id ? { 'data-id': a.id } : {}) },
    target: { default: '', parseHTML: (el) => el.getAttribute('data-target') ?? el.textContent ?? '', renderHTML: (a) => ({ 'data-target': a.target }) },
    alias: { default: null, parseHTML: (el) => el.getAttribute('data-alias'), renderHTML: (a) => (a.alias ? { 'data-alias': a.alias } : {}) },
  }),
  parseHTML: () => [{ tag: 'a[data-wikilink]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'a',
    mergeAttributes(HTMLAttributes, { 'data-wikilink': '', class: `wikilink${node.attrs.id ? '' : ' is-unresolved'}`, role: 'link' }),
    wikiLabel(node.attrs as WikiAttrs),
  ],
  renderText: ({ node }) => wikiLabel(node.attrs as WikiAttrs),
  addInputRules() {
    // Escribir «[[Nota]]» entero (sin elegir en el buscador) también lo convierte.
    const type = this.type;
    return [
      new InputRule({
        find: /\[\[([^[\]\n]+)\]\]$/,
        handler: ({ state, range, match }) => {
          const { note, section, alias } = splitWiki(match[1]);
          if (!note) return null;
          state.tr.replaceWith(range.from, range.to, type.create({ id: null, target: section ? `${note}#${section}` : note, alias }));
        },
      }),
    ];
  },
});

// ==resaltado==
export const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ HTMLAttributes }) => ['mark', HTMLAttributes, 0],
  addInputRules() {
    return [markInputRule({ find: /(?:^|\s)(==(?!\s)([^=]+)(?<!\s)==)$/, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: /(?:^|\s)(==(?!\s)([^=]+)(?<!\s)==)/g, type: this.type })];
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => this.editor.commands.toggleMark(this.name) };
  },
});

// Casillas: «- [ ] » al escribir, como en Obsidian. El «- » ya hace una lista,
// así que «[ ] » al principio de un punto la convierte en lista de tareas.
// Cada casilla es una tarea (las sangradas, subtareas): además de hecha puede
// estar en curso («[/]») o bloqueada («[!]»).
const BOX: Record<string, { checked: boolean; status: string | null }> = {
  ' ': { checked: false, status: null },
  x: { checked: true, status: null },
  '/': { checked: false, status: 'doing' },
  '!': { checked: false, status: 'blocked' },
};
const TaskInput = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      status: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => el.getAttribute('data-status'),
        renderHTML: (a) => (a.status ? { 'data-status': a.status } : {}),
      },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX/!])?\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          const inList = $from.depth >= 2 && $from.node(-1).type.name === 'listItem';
          chain()
            .deleteRange(range)
            .command(({ commands }) => (inList ? commands.toggleList('taskList', 'taskItem') : commands.toggleTaskList()))
            .updateAttributes('taskItem', BOX[(match[1] ?? ' ').toLowerCase()])
            .run();
        },
      }),
    ];
  },
  addProseMirrorPlugins() {
    // Una casilla que se marca deja de estar en curso o bloqueada.
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((tr) => tr.docChanged)) return null;
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'taskItem' && node.attrs.checked && node.attrs.status) tr.setNodeMarkup(pos, undefined, { ...node.attrs, status: null });
          });
          return tr.docChanged ? tr.setMeta('addToHistory', false) : null;
        },
      }),
    ];
  },
});

export const tasks = [TaskList, TaskInput.configure({ nested: true })];

const hrefOf = (url: string) => (/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`);

// [texto](url) en Markdown, escrito a mano o dejado por Ctrl K: se vuelve un
// enlace al cerrar el paréntesis o en cuanto el cursor sale de él. Así se
// puede escribir el texto y luego la dirección, como en Obsidian.
const MD_LINK = /(?<![!\[])\[([^[\]\n￼]+)\]\(([^()\s￼]+)\)/g;
const WIKI_TEXT = /(?<!!)\[\[([^[\]\n￼]+)\]\]/g;
const mdLinkKey = new PluginKey('markdownLinks');

function linkify(state: EditorState, around: number[]): Transaction | null {
  const link = state.schema.marks.link;
  if (!link) return null;
  const wiki = state.schema.nodes.wikilink;
  const tr = state.tr;
  const seen = new Set<number>();
  for (const at of around) {
    if (at < 0 || at > state.doc.content.size) continue;
    const $at = state.doc.resolve(at);
    const block = $at.parent;
    if (!block.isTextblock || block.type.spec.code) continue;
    const start = $at.start();
    if (seen.has(start)) continue;
    seen.add(start);
    const text = block.textBetween(0, block.content.size, undefined, '￼');
    // Los [texto](url) y, si se volvieron a escribir desde el menú, los [[enlaces]].
    const found = [...text.matchAll(MD_LINK), ...(wiki ? text.matchAll(WIKI_TEXT) : [])].sort((x, y) => x.index! - y.index!);
    let last = -1;
    for (const m of found) {
      const from = start + m.index!;
      const to = from + m[0].length;
      if (from < last) continue;
      // Mientras se escribe dentro, se deja como está.
      const cursor = state.selection.from;
      if (state.selection.empty && cursor > from && cursor < to) continue;
      let plain = true;
      state.doc.nodesBetween(from, to, (n) => {
        if (n.isText && n.marks.some((mk) => mk.type.spec.code)) plain = false;
      });
      if (!plain) continue;
      last = to;
      const a = tr.mapping.map(from);
      const b = tr.mapping.map(to);
      if (m[0].startsWith('[[')) {
        const { note, section, alias } = splitWiki(m[1]);
        if (note) tr.replaceWith(a, b, wiki!.create({ id: null, target: section ? `${note}#${section}` : note, alias }));
        continue;
      }
      tr.replaceWith(a, b, state.schema.text(m[1], [...state.doc.resolve(from + 1).marks().filter((mk) => mk.type !== link), link.create({ href: hrefOf(m[2]) })]));
    }
  }
  return tr.steps.length ? tr.removeStoredMark(link) : null;
}

export const MarkdownLinkInput = Extension.create({
  name: 'markdownLinkInput',
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![![])\[([^[\]\n]+)\]\((\S+)\)$/,
        handler: ({ state, range, match }) => {
          const link = state.schema.marks.link;
          if (!link) return null;
          state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [link.create({ href: hrefOf(match[2]) })])).removeStoredMark(link);
        },
      }),
    ];
  },
  // Intro con el cursor dentro de «[texto](url)» no lo parte: primero lo
  // cierra como enlace y luego salta de línea detrás.
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type.spec.code) return false;
        const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, '￼');
        for (const m of text.matchAll(MD_LINK)) {
          const end = m.index! + m[0].length;
          if ($from.parentOffset > m.index! && $from.parentOffset < end) {
            view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.start() + end)));
            break;
          }
        }
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mdLinkKey,
        appendTransaction: (trs, old, state) => {
          if (!trs.some((tr) => tr.selectionSet || tr.docChanged) || trs.some((tr) => tr.getMeta(mdLinkKey))) return null;
          // Donde estaba el cursor (ya puede haber salido) y donde está.
          const prev = trs.reduce((pos, tr) => tr.mapping.map(pos), old.selection.from);
          const tr = linkify(state, [prev, state.selection.from]);
          return tr && tr.setMeta(mdLinkKey, true).setMeta('addToHistory', true);
        },
      }),
    ];
  },
});

// ── El buscador de [[ ─────────────────────────────────────────────────
// Mientras el cursor está justo detrás de «[[algo», avisa con lo escrito y
// dónde está, para que la hoja muestre la lista de notas. Esc lo cierra hasta
// que se escribe otro «[[».

export type WikiQuery = { from: number; to: number; query: string; left: number; top: number; bottom: number };

type WikiState = { dismissed: number | null };
export const wikiSuggestKey = new PluginKey<WikiState>('wikiSuggest');

function findQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if ($pos.parent.type.spec.code) return null;
  const before = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 200), $pos.parentOffset, undefined, '￼');
  const m = /\[\[([^[\]\n￼]*)$/.exec(before);
  if (!m) return null;
  return { from: $pos.pos - m[0].length, to: $pos.pos, query: m[1] };
}

export type WikiSuggestOptions = {
  onChange: (q: WikiQuery | null) => void;
  // Flechas, Enter y Tab mientras la lista está abierta. true si los usó.
  onKey: (e: KeyboardEvent) => boolean;
};

export const WikiSuggest = Extension.create<WikiSuggestOptions>({
  name: 'wikiSuggest',
  // Antes que Enter y Tab del editor (partir párrafo, sangrar listas).
  priority: 1000,
  addOptions: () => ({ onChange: () => {}, onKey: () => false }),
  addProseMirrorPlugins() {
    const options = this.options;
    const active = (state: EditorState) => {
      const hit = findQuery(state);
      return hit && hit.from !== wikiSuggestKey.getState(state)?.dismissed ? hit : null;
    };
    let last = '';
    return [
      new Plugin<WikiState>({
        key: wikiSuggestKey,
        state: {
          init: () => ({ dismissed: null }),
          apply: (tr, v) => {
            const meta = tr.getMeta(wikiSuggestKey) as WikiState | undefined;
            if (meta) return meta;
            return v.dismissed === null || !tr.docChanged ? v : { dismissed: tr.mapping.map(v.dismissed) };
          },
        },
        view: () => ({
          update: (view) => {
            const hit = active(view.state);
            const key = hit ? `${hit.from}:${hit.query}` : '';
            if (key === last) return;
            last = key;
            if (!hit) return options.onChange(null);
            const at = view.coordsAtPos(hit.from);
            options.onChange({ ...hit, left: at.left, top: at.top, bottom: at.bottom });
          },
          destroy: () => {
            if (last) options.onChange(null);
          },
        }),
        props: {
          handleKeyDown: (view, event) => {
            const hit = active(view.state);
            if (!hit) return false;
            if (event.key === 'Escape') {
              view.dispatch(view.state.tr.setMeta(wikiSuggestKey, { dismissed: hit.from }));
              return true;
            }
            return options.onKey(event);
          },
        },
      }),
    ];
  },
});

// Los [[enlaces]] de un documento, en orden.
export function wikiLinksIn(doc: PMNode): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'wikilink') out.push({ node, pos });
  });
  return out;
}
