import { parseProps, type NoteRow, type PropertyDef } from '../api';

// Etiquetas: una propiedad de tipo «tags» guarda una lista de palabras.
// Al escribir, «#palabra» en cualquier sitio del texto es una etiqueta.

const TAG = /#([\p{L}\p{N}_-]+)/gu;

// Separa las etiquetas del texto: «nota hija#test_tag» → «nota hija» + [test_tag].
export function splitTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const rest = text.replace(TAG, (_, tag: string) => {
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    return ' ';
  });
  return { text: rest.replace(/\s+/g, ' ').replace(/\s*>\s*/g, '>').trim(), tags };
}

// Une etiquetas sin repetir (sin distinguir mayúsculas).
export function mergeTags(a: string[], b: string[]) {
  const out = [...a];
  for (const t of b) if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

// Todas las etiquetas de una nota, de todas sus propiedades de tipo etiquetas.
export function tagsOf(row: NoteRow, defs: PropertyDef[]): string[] {
  const props = parseProps(row.props);
  let out: string[] = [];
  for (const d of defs) {
    const v = props[d.id];
    if (d.type === 'tags' && Array.isArray(v)) out = mergeTags(out, v);
  }
  return out;
}
