import { getHTMLFromFragment, getSchema, type JSONContent } from '@tiptap/react';
import { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TableKit } from '@tiptap/extension-table';
import { mediaNodes } from './media';

export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, autolink: true },
  }),
  Placeholder.configure({ placeholder: 'Escribe algo…' }),
  // Tablas: sobre todo las que llegan importadas de Markdown.
  TableKit.configure({ table: { resizable: false } }),
  ...mediaNodes,
];

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
