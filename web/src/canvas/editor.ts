import { Extension, getHTMLFromFragment, getSchema, type Editor, type JSONContent } from '@tiptap/react';
import { Node as PMNode, Slice } from '@tiptap/pm/model';
import { AllSelection, Plugin, Selection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { mediaNodes } from './media';
import { embedNodes } from './embeds';
import { getLang, t } from '../i18n';
import { markdownToDoc } from './markdown';
import { Highlight, MarkdownLinkInput, WikiLink, tasks } from './obsidian';
import { BlockKit, blockNodes } from './blocks';
import { joinTitle, parseBody, splitTitle, titleBlock, titleFrom } from '../../../server/src/doc/json';

export { joinTitle, parseBody, splitTitle, titleBlock, titleFrom, type TitleSplit } from '../../../server/src/doc/json';

export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // Un clic en un enlace es para escribir o seleccionar; Ctrl/⌘ clic lo abre.
    link: { openOnClick: false, autolink: true },
    codeBlock: false,
    dropcursor: { class: 'note-dropcursor', width: 2 },
  }),
  // Bloques de código con colores según su lenguaje (```js, ```python…); sin
  // lenguaje, se adivina.
  CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
  // Encabezados, listas, tareas y desplegables vacíos dicen qué son; las
  // líneas normales se quedan en blanco.
  Placeholder.configure({
    includeChildren: true,
    placeholder: ({ editor, node, pos }) => {
      if (node.type.name === 'heading') return t('Encabezado {n}', { n: node.attrs.level });
      if (node.type.name !== 'paragraph') return '';
      // Las decoraciones se calculan con el documento nuevo antes de que el
      // editor lo tenga: si su estado aún no coincide, no se mira el contenedor.
      const doc = editor.state.doc;
      if (pos > doc.content.size || doc.nodeAt(pos) !== node) return '';
      const $p = doc.resolve(pos);
      const parent = $p.parent.type.name;
      if (parent === 'listItem') return t('Lista');
      if (parent === 'taskItem') return t('Tarea');
      if (parent === 'toggle' && $p.index() === 0) return t('Desplegable');
      return '';
    },
  }),
  // Tablas, como en Notion: el ancho de cada columna se cambia arrastrando su borde.
  TableKit.configure({ table: { resizable: true, cellMinWidth: 60, lastColumnResizable: true } }),
  ...mediaNodes,
  // Enlaces vistos incrustados: la ficha de una web y otra nota entera.
  ...embedNodes,
  // Lo propio de Obsidian: [[enlaces]], ==resaltado== y casillas.
  WikiLink,
  Highlight,
  ...tasks,
  // Lo de Notion: columnas, avisos, desplegables y colores.
  ...blockNodes,
];

// Ctrl/⌘ K pone un enlace a lo seleccionado, o lo quita si ya lo es.
export function promptLink(ed: Editor) {
  if (ed.isActive('link')) return ed.chain().focus().extendMarkRange('link').unsetLink().run();
  // Como en Obsidian: entra «[texto]()» en Markdown. Sin selección, el cursor
  // queda para el texto; con ella, para la dirección. Al salir, es un enlace.
  const { from, to, empty } = ed.state.selection;
  const text = ed.state.doc.textBetween(from, to, ' ');
  const cursor = empty ? from + 1 : from + text.length + 3;
  return ed.chain().focus().insertContentAt({ from, to }, { type: 'text', text: `[${text}]()` }).setTextSelection(cursor).run();
}
const LinkKey = Extension.create({
  name: 'linkKey',
  addKeyboardShortcuts() {
    return { 'Mod-k': () => promptLink(this.editor) };
  },
});

// Con todo seleccionado (Ctrl A), las flechas, Inicio y Fin llevan el cursor
// al principio o al final en el acto, como en cualquier editor.
const collapse = (toEnd: boolean) => ({ editor }: { editor: Editor }) => {
  const { state, view } = editor;
  if (!(state.selection instanceof AllSelection)) return false;
  view.dispatch(state.tr.setSelection(toEnd ? Selection.atEnd(state.doc) : Selection.atStart(state.doc)).scrollIntoView());
  return true;
};
const SelectAllKeys = Extension.create({
  name: 'selectAllKeys',
  addKeyboardShortcuts() {
    const end = collapse(true);
    const start = collapse(false);
    return { ArrowRight: end, ArrowDown: end, End: end, 'Mod-End': end, ArrowLeft: start, ArrowUp: start, Home: start, 'Mod-Home': start };
  },
});

// Texto pegado que viene en Markdown (de otra app de notas, de un chat…) entra
// ya con su formato. Si trae HTML, manda el HTML.
const MARKDOWN = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|\s*(```|~~~)|\|.*\|\s*$)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|\[\[[^\]\n]+\]\]|==[^=\n]+==|~~[^~\n]+~~/m;
const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const data = event.clipboardData;
            if (!data || data.types.includes('text/html') || data.files.length) return false;
            const text = data.getData('text/plain');
            // En un bloque de código, o una sola línea sin marcas: tal cual.
            if (!MARKDOWN.test(text) || view.state.selection.$from.parent.type.spec.code) return false;
            try {
              const doc = view.state.schema.nodeFromJSON(markdownToDoc(text).doc);
              // Un solo párrafo se funde con la línea en la que se pega.
              const open = doc.childCount === 1 && doc.firstChild!.isTextblock ? 1 : 0;
              view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, open, open)).scrollIntoView());
              return true;
            } catch {
              return false;
            }
          },
        },
      }),
    ];
  },
});

// Solo en el editor de la hoja; las vistas previas usan `extensions` a secas.
export const editingExtensions = [LinkKey, SelectAllKeys, MarkdownPaste, MarkdownLinkInput, BlockKit];

// Pone al día el texto con la versión que llega de otro dispositivo cambiando
// solo lo que difiere: la selección y el cursor se quedan donde estaban, y
// deshacer no se lleva el cambio ajeno.
export function applyRemote(editor: Editor, json: JSONContent | null) {
  const { state } = editor;
  let next: PMNode;
  try {
    next = json ? state.schema.nodeFromJSON(json) : state.schema.topNodeType.createAndFill()!;
  } catch {
    return;
  }
  const start = state.doc.content.findDiffStart(next.content);
  if (start == null) return;
  let { a: endA, b: endB } = state.doc.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  try {
    const tr = state.tr.replace(start, endA, next.slice(start, endB));
    editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('preventUpdate', true));
  } catch {
    editor.commands.setContent(json ?? '', { emitUpdate: false });
  }
}


// El esquema se construye una vez (generateHTML lo rehace en cada llamada) y el
// HTML de cada cuerpo se recuerda: con miles de notas, pintar no cuesta de nuevo.
let schema: ReturnType<typeof getSchema> | null = null;
const htmlCache = new Map<string, string>();

export function bodyToHtml(bodyJson: string | null): string {
  if (!bodyJson) return '';
  // Las fichas de adjuntos llevan texto de la interfaz: cada idioma, su HTML.
  const key = `${getLang()}:${bodyJson}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  const doc = parseBody(bodyJson);
  let html = '';
  if (doc) {
    try {
      schema ??= getSchema(extensions);
      html = getHTMLFromFragment(PMNode.fromJSON(schema, doc).content, schema);
    } catch {
      html = '';
    }
  }
  if (htmlCache.size > 5000) htmlCache.delete(htmlCache.keys().next().value!);
  htmlCache.set(key, html);
  return html;
}

// Renombrar una nota de texto desde fuera (las migas): el título es el primer
// bloque del texto, así que se cambia ahí, como si se escribiera en la hoja.
export function retitle(note: { bodyJson: string | null; bodyText: string | null }, title: string) {
  const split = splitTitle(parseBody(note.bodyJson));
  const head = titleBlock(title, split.head);
  const rest = split.head ? (note.bodyText ?? '').split('\n').slice(1).join('\n') : (note.bodyText ?? '');
  const bodyText = head ? `${title}\n${rest}` : rest;
  return { bodyJson: JSON.stringify(joinTitle(head, split.body)), bodyText, title: titleFrom(bodyText) };
}
