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

// ── Enlaces a un punto de una nota ───────────────────────────────────
// [[Nota#^abc123]] lleva a un bloque concreto (como en Obsidian): el bloque
// guarda ese id en `blockId` y en Markdown se escribe « ^abc123» al final de
// su línea. [[Nota#Encabezado]] lleva a esa sección.

export const BLOCK_ID = /^[A-Za-z0-9-]+$/;

export function newBlockId(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += abc[Math.floor(Math.random() * abc.length)];
  return id;
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

export function textOf(n: JSONContent): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'wikilink') return String(n.attrs?.alias || n.attrs?.target || '');
  return (n.content ?? []).map(textOf).join(n.type === 'paragraph' || n.type === 'heading' ? '' : ' ');
}

// Los bloques a los que lleva «#sección» en el documento: el bloque con ese id
// («^abc123»), o el encabezado con ese texto y lo que tiene debajo hasta el
// siguiente del mismo nivel. null si no está.
export function sectionOf(doc: JSONContent | null, section: string): JSONContent[] | null {
  if (!doc) return null;
  if (section.startsWith('^')) {
    const id = section.slice(1);
    let hit: JSONContent | null = null;
    const walk = (n: JSONContent) => {
      if (hit) return;
      if (n.attrs?.blockId === id) hit = n;
      else (n.content ?? []).forEach(walk);
    };
    walk(doc);
    return hit ? [hit] : null;
  }
  const want = fold(section);
  const top = doc.content ?? [];
  const at = top.findIndex((b) => b.type === 'heading' && fold(textOf(b)) === want);
  if (at < 0) return null;
  const level = Number(top[at].attrs?.level ?? 1);
  let end = at + 1;
  while (end < top.length && !(top[end].type === 'heading' && Number(top[end].attrs?.level ?? 1) <= level)) end++;
  return top.slice(at, end);
}
