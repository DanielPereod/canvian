import { generateHTML, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';

export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, autolink: true },
  }),
  Placeholder.configure({ placeholder: 'Escribe algo…' }),
];

export function parseBody(bodyJson: string | null): JSONContent | null {
  if (!bodyJson) return null;
  try {
    return JSON.parse(bodyJson) as JSONContent;
  } catch {
    return null;
  }
}

export function bodyToHtml(bodyJson: string | null): string {
  const doc = parseBody(bodyJson);
  if (!doc) return '';
  try {
    return generateHTML(doc, extensions);
  } catch {
    return '';
  }
}

// El título de una nota es su primera línea con texto; sirve para buscar y para ⌘K.
export function titleFrom(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}
