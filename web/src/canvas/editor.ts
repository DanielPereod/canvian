import { Extension, getHTMLFromFragment, getSchema, type Editor, type JSONContent } from '@tiptap/react';
import { Node as PMNode, Slice } from '@tiptap/pm/model';
import { AllSelection, Plugin, Selection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TableKit } from '@tiptap/extension-table';
import { mediaNodes } from './media';
import { markdownToDoc } from './markdown';
import { Highlight, MarkdownLinkInput, WikiLink, tasks } from './obsidian';

export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // Un clic en un enlace es para escribir o seleccionar; Ctrl/⌘ clic lo abre.
    link: { openOnClick: false, autolink: true },
  }),
  Placeholder.configure({ placeholder: 'Escribe algo…' }),
  // Tablas: sobre todo las que llegan importadas de Markdown.
  TableKit.configure({ table: { resizable: false } }),
  ...mediaNodes,
  // Lo propio de Obsidian: [[enlaces]], ==resaltado== y casillas.
  WikiLink,
  Highlight,
  ...tasks,
];

// Ctrl/⌘ K pone un enlace a lo seleccionado, o lo quita si ya lo es.
const LinkKey = Extension.create({
  name: 'linkKey',
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        const ed = this.editor;
        if (ed.isActive('link')) return ed.chain().focus().extendMarkRange('link').unsetLink().run();
        const url = window.prompt('Enlace', 'https://')?.trim();
        if (!url || url === 'https://') return true;
        const href = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`;
        if (ed.state.selection.empty) return ed.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] }).run();
        return ed.chain().focus().setLink({ href }).run();
      },
    };
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
const MARKDOWN = /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|```|\|.*\|\s*$)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|\[\[[^\]\n]+\]\]|==[^=\n]+==|~~[^~\n]+~~/m;
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
export const editingExtensions = [LinkKey, SelectAllKeys, MarkdownPaste, MarkdownLinkInput];

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

export function parseBody(bodyJson: string | null): JSONContent | null {
  if (!bodyJson) return null;
  try {
    return JSON.parse(bodyJson) as JSONContent;
  } catch {
    return null;
  }
}

// El esquema se construye una vez (generateHTML lo rehace en cada llamada) y el
// HTML de cada cuerpo se recuerda: con miles de notas, pintar no cuesta de nuevo.
let schema: ReturnType<typeof getSchema> | null = null;
const htmlCache = new Map<string, string>();

export function bodyToHtml(bodyJson: string | null): string {
  if (!bodyJson) return '';
  const hit = htmlCache.get(bodyJson);
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
  htmlCache.set(bodyJson, html);
  return html;
}

// El título de una nota es su primera línea con texto; sirve para buscar y para Ctrl P.
export function titleFrom(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}
