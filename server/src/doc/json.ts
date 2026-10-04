// El documento de una nota, tal como lo guarda el editor (Tiptap) en body_json.
// Este directorio lo comparten el servidor y la web: aquí no se importa nada
// del navegador ni de Node.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type JSONContent = {
  type?: string;
  attrs?: Record<string, any>;
  content?: JSONContent[];
  marks?: { type: string; attrs?: Record<string, any>; [key: string]: any }[];
  text?: string;
  [key: string]: any;
};

export function parseBody(bodyJson: string | null): JSONContent | null {
  if (!bodyJson) return null;
  try {
    return JSON.parse(bodyJson) as JSONContent;
  } catch {
    return null;
  }
}

// El título de una nota es su primera línea con texto; sirve para buscar y para Ctrl P.
export function titleFrom(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}

// El título se edita aparte, como en Notion, pero se guarda como hasta ahora:
// es el primer bloque del texto. Así el resto (búsqueda, vista previa, tareas,
// exportar) sigue igual. Solo cuenta como título un párrafo o encabezado de
// texto llano; si la nota empieza por otra cosa (una lista, una imagen), no tiene.
export type TitleSplit = { title: string; head: JSONContent | null; body: JSONContent };

function plainText(node: JSONContent): string | null {
  let text = '';
  for (const c of node.content ?? []) {
    if (c.type === 'text') text += c.text ?? '';
    else if (c.type === 'hardBreak') text += ' ';
    else return null;
  }
  return text;
}

export function splitTitle(doc: JSONContent | null): TitleSplit {
  const content = doc?.content ?? [];
  const first = content[0];
  const text = first && (first.type === 'heading' || first.type === 'paragraph') ? plainText(first) : null;
  if (text === null) return { title: '', head: null, body: { type: 'doc', content } };
  return { title: text, head: first, body: { ...doc, type: 'doc', content: content.slice(1) } };
}

// Lo contrario: el título (como un encabezado) delante del texto. Si no ha
// cambiado, el bloque se queda como estaba, con su formato.
export function titleBlock(title: string, head: JSONContent | null): JSONContent | null {
  if (head && plainText(head) === title) return head;
  if (!head && !title) return null;
  return { type: head?.type ?? 'heading', ...(head ? (head.attrs ? { attrs: head.attrs } : {}) : { attrs: { level: 1 } }), ...(title ? { content: [{ type: 'text', text: title }] } : {}) };
}

export function joinTitle(head: JSONContent | null, body: JSONContent): JSONContent {
  return head ? { ...body, type: 'doc', content: [head, ...(body.content ?? [])] } : body;
}


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
