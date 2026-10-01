import type { JSONContent } from '@tiptap/react';
import { splitWiki } from './obsidian';

// Markdown ↔ documento de Tiptap, lo justo para importar notas sueltas (o de
// Obsidian) y exportar el lienzo a JSON Canvas. No pretende cubrir todo Markdown.

type Mark = { type: string; attrs?: Record<string, unknown> };

// Enlaces [texto](url "título"), con paréntesis dentro de la url; direcciones
// sueltas (sin tocar sus _ ni *); y cursiva o negrita con _ solo si no está
// dentro de una palabra, como en Markdown estándar.
const LINK = String.raw`\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"]*")?\)`;
const URL_RE = String.raw`https?:\/\/[^\s<>]+`;
const INLINE = new RegExp(
  [
    String.raw`\*\*[^*]+\*\*`,
    String.raw`(?<![\p{L}\p{N}_])__[^_]+__(?![\p{L}\p{N}_])`,
    '`[^`]+`',
    String.raw`!?\[\[[^\]]+\]\]`,
    String.raw`==[^=\s][^=]*==`,
    String.raw`~~[^~\s][^~]*~~`,
    LINK,
    URL_RE,
    String.raw`\*[^*\s][^*]*\*`,
    String.raw`(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_])`,
  ].join('|'),
  'gu',
);

// La puntuación del final de la frase no es parte de la dirección.
const urlTail = (url: string) => /[.,;:!?)\]]+$/.exec(url)?.[0] ?? '';

function inline(text: string, links: string[]): JSONContent[] {
  const out: JSONContent[] = [];
  const push = (t: string, marks?: Mark[]) => t && out.push(marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index));
    let tok = m[0];
    if (tok.startsWith('**') || tok.startsWith('__')) push(tok.slice(2, -2), [{ type: 'bold' }]);
    else if (tok.startsWith('`')) push(tok.slice(1, -1), [{ type: 'code' }]);
    else if (tok.startsWith('==')) push(tok.slice(2, -2), [{ type: 'highlight' }]);
    else if (tok.startsWith('~~')) push(tok.slice(2, -2), [{ type: 'strike' }]);
    else if (/^!?\[\[/.test(tok)) {
      // [[Nota#Sección|alias]] (o ![[Nota]], que Obsidian incrusta) → un enlace a
      // la nota, y se recuerda para unir las notas.
      const { note, section, alias } = splitWiki(tok.replace(/^!/, '').slice(2, -2));
      if (note) {
        links.push(note);
        out.push({ type: 'wikilink', attrs: { id: null, target: section ? `${note}#${section}` : note, alias } });
      } else push(tok);
    } else if (tok.startsWith('[')) {
      const [, label, href] = /^\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)$/.exec(tok)!;
      push(label, [{ type: 'link', attrs: { href } }]);
    } else if (/^https?:/.test(tok)) {
      const tail = urlTail(tok);
      tok = tok.slice(0, tok.length - tail.length);
      push(tok, [{ type: 'link', attrs: { href: tok } }]);
      push(tail);
      last = (m.index ?? 0) + tok.length + tail.length;
      continue;
    } else push(tok.slice(1, -1), [{ type: 'italic' }]);
    last = (m.index ?? 0) + tok.length;
  }
  push(text.slice(last));
  return out;
}

// Tablas de Markdown: una fila de cabecera, la de guiones y las demás.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

// Una línea de Markdown → su contenido en línea (texto con marcas y [[enlaces]]).
export const inlineFromMd = (text: string): JSONContent[] => inline(text, []);

const wikiMd = (c: JSONContent) => `[[${String(c.attrs?.target ?? '')}${c.attrs?.alias ? `|${String(c.attrs.alias)}` : ''}]]`;
// Y al revés: el contenido de un párrafo como una línea de Markdown.
export const inlineToMd = (content: JSONContent[] | undefined): string =>
  (content ?? []).map((c) => (c.type === 'hardBreak' ? '\n' : c.type === 'wikilink' ? wikiMd(c) : marksToMd(c))).join('');

const para = (text: string, links: string[]): JSONContent => {
  const content = inline(text, links);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

// Una línea de lista: «- », «1. » o una casilla «- [ ] » (también «[x]», «[/]»
// en curso y «[!]» bloqueada), con su sangría.
type ListLine = { indent: number; type: 'taskList' | 'bulletList' | 'orderedList'; box: string | undefined; text: string };
function listLine(line: string): ListLine | null {
  const m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX/!])\](?=\s|$)\s?)?/.exec(line);
  if (!m) return null;
  const type = m[3] !== undefined ? 'taskList' : /\d/.test(m[2]) ? 'orderedList' : 'bulletList';
  return { indent: m[1].replace(/\t/g, '    ').length, type, box: m[3], text: line.slice(m[0].length) };
}

const BOX_STATUS: Record<string, string> = { '/': 'doing', '!': 'blocked' };

const indentOf = (line: string) => /^\s*/.exec(line.replace(/\t/g, '    '))![0].length;
const dedent = (line: string, n: number) => line.replace(/\t/g, '    ').slice(Math.min(n, indentOf(line)));

// Bloques de código con ``` o ~~~, también sangrados (dentro de una lista) y
// con su lenguaje («```js»). Se cierran con la misma valla, al menos igual de larga.
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`~\s]*)[^`~]*$/;

// Una lista y lo que cuelga de ella: lo más sangrado va dentro del punto de
// encima (así, una casilla sangrada bajo otra es su subtarea, y un bloque de
// código o un párrafo sangrados siguen en ese punto). Las líneas en blanco
// entre puntos no cortan la lista.
function parseList(lines: string[], start: number, ctx: Ctx): [JSONContent, number] {
  const first = listLine(lines[start])!;
  const items: JSONContent[] = [];
  let i = start;
  while (i < lines.length) {
    const l = listLine(lines[i]);
    if (!l || l.indent !== first.indent || l.type !== first.type) break;
    // Lo que va debajo del punto: líneas en blanco o más sangradas que él.
    let end = i + 1;
    let last = i;
    while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > l.indent)) {
      if (lines[end].trim()) last = end;
      end++;
    }
    const inner = lines.slice(i + 1, last + 1);
    const shift = Math.min(...inner.filter((s) => s.trim()).map(indentOf));
    const children = inner.length ? parseBlocks(inner.map((s) => dedent(s, shift)), ctx) : [];
    const status = BOX_STATUS[l.box ?? ''];
    items.push(
      first.type === 'taskList'
        ? { type: 'taskItem', attrs: { checked: /x/i.test(l.box ?? ''), ...(status ? { status } : {}) }, content: [para(l.text, ctx.links), ...children] }
        : { type: 'listItem', content: [para(l.text, ctx.links), ...children] },
    );
    i = last + 1;
    // Tras líneas en blanco, la lista sigue si el siguiente es otro punto igual.
    let next = i;
    while (next < lines.length && !lines[next].trim()) next++;
    const n = next < lines.length ? listLine(lines[next]) : null;
    if (n && n.indent === first.indent && n.type === first.type) i = next;
  }
  const num = first.type === 'orderedList' ? parseInt(lines[start].trim(), 10) : 1;
  return [{ type: first.type, ...(num !== 1 ? { attrs: { start: num } } : {}), content: items }, i];
}

type Ctx = { links: string[]; heading: string | null };

// Con `frontmatter`, se salta la cabecera «---» de Obsidian (al importar); al
// editar el Markdown de una nota, un «---» al principio es una raya.
export function markdownToDoc(md: string, frontmatter = true): { doc: JSONContent; links: string[]; heading: string | null } {
  const ctx: Ctx = { links: [], heading: null };
  md = md.replace(/\r\n?/g, '\n');
  const lines = (frontmatter ? md.replace(/^---\n[\s\S]*?\n---\n/, '') : md).split('\n');
  const content = parseBlocks(lines, ctx);
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, links: ctx.links, heading: ctx.heading };
}

function parseBlocks(lines: string[], ctx: Ctx): JSONContent[] {
  const { links } = ctx;
  const content: JSONContent[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      ctx.heading ??= h[2].trim();
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: inline(h[2], links) });
      i++;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      const [, pad, fence, lang] = f;
      const close = new RegExp(String.raw`^\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\s*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) code.push(dedent(lines[i++], indentOf(pad)));
      i++;
      content.push({ type: 'codeBlock', attrs: { language: lang || null }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      content.push({ type: 'blockquote', content: [para(quote.join(' '), links)] });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) body.push(cells(lines[i++]));
      const cols = Math.max(head.length, ...body.map((r) => r.length));
      const row = (r: string[], type: string): JSONContent => ({
        type: 'tableRow',
        content: Array.from({ length: cols }, (_, c) => ({ type, content: [para(r[c] ?? '', links)] })),
      });
      content.push({ type: 'table', content: [row(head, 'tableHeader'), ...body.map((r) => row(r, 'tableCell'))] });
      continue;
    }
    if (listLine(line)) {
      const [list, next] = parseList(lines, i, ctx);
      content.push(list);
      i = next;
      continue;
    }
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !FENCE.test(lines[i]) && !(text.length && TABLE_ROW.test(lines[i]))) text.push(lines[i++].trim());
    content.push(para(text.join(' '), links));
  }
  return content;
}

export function docText(doc: JSONContent): string {
  const block = (n: JSONContent): string =>
    n.type === 'text'
      ? (n.text ?? '')
      : n.type === 'wikilink'
        ? String(n.attrs?.alias || n.attrs?.target || '')
        : (n.content ?? []).map(block).join(n.type === 'tableRow' ? ' · ' : ['doc', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'listItem', 'taskItem', 'table'].includes(n.type ?? '') ? '\n' : '');
  return block(doc).trim();
}

function marksToMd(n: JSONContent): string {
  let t = n.text ?? '';
  for (const m of n.marks ?? []) {
    if (m.type === 'bold') t = `**${t}**`;
    else if (m.type === 'italic') t = `*${t}*`;
    else if (m.type === 'code') t = `\`${t}\``;
    else if (m.type === 'strike') t = `~~${t}~~`;
    else if (m.type === 'highlight') t = `==${t}==`;
    else if (m.type === 'link') t = t === m.attrs?.href ? t : `[${t}](${String(m.attrs?.href ?? '')})`;
  }
  return t;
}

export function docToMarkdown(doc: JSONContent | null): string {
  if (!doc) return '';
  const inl = (n: JSONContent) => inlineToMd(n.content);
  const block = (n: JSONContent, indent = ''): string => {
    switch (n.type) {
      case 'heading':
        return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inl(n)}`;
      case 'paragraph':
        return indent + inl(n);
      case 'bulletList':
      case 'orderedList':
        return (n.content ?? [])
          .map((li, i) => {
            const [first, ...rest] = li.content ?? [];
            const mark = n.type === 'orderedList' ? `${Number(n.attrs?.start ?? 1) + i}.` : '-';
            const head = `${indent}${mark} ${first ? inl(first) : ''}`;
            return [head, ...rest.map((r) => block(r, indent + ' '.repeat(mark.length + 1)))].join('\n');
          })
          .join('\n');
      case 'taskList':
        return (n.content ?? [])
          .map((li) => {
            const [first, ...rest] = li.content ?? [];
            const box = li.attrs?.checked ? 'x' : li.attrs?.status === 'doing' ? '/' : li.attrs?.status === 'blocked' ? '!' : ' ';
            const head = `${indent}- [${box}] ${first ? inl(first) : ''}`;
            return [head, ...rest.map((r) => block(r, indent + '  '))].join('\n');
          })
          .join('\n');
      case 'blockquote':
        return (n.content ?? []).map((c) => `> ${block(c)}`).join('\n');
      case 'codeBlock': {
        const code = inl(n);
        const fence = '`'.repeat(Math.max(3, ...(code.match(/`{3,}/g) ?? []).map((f) => f.length + 1)));
        return [fence + String(n.attrs?.language ?? ''), ...code.split('\n'), fence].map((l) => (l ? indent + l : l)).join('\n');
      }
      case 'horizontalRule':
        return '---';
      case 'table': {
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => (c.content ?? []).map(inl).join(' ').replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const line = (r: string[]) => `| ${r.join(' | ')} |`;
        return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
      }
      case 'image':
        return `![](${String(n.attrs?.src ?? '')})`;
      case 'video':
      case 'audio':
        return `[${n.type === 'video' ? 'Vídeo' : 'Audio'}](${String(n.attrs?.src ?? '')})`;
      case 'youtube':
        return String(n.attrs?.src ?? '');
      case 'file':
        return `[${String(n.attrs?.name || 'Archivo').replace(/[[\]]/g, '\\$&')}](${String(n.attrs?.src ?? '')})`;
      default:
        return (n.content ?? []).map((c) => block(c, indent)).join('\n\n');
    }
  };
  return (doc.content ?? []).map((b) => block(b)).join('\n\n').trim();
}

// El Markdown de una nota para verlo y editarlo, sin los párrafos vacíos (que
// en Markdown solo serían más líneas en blanco).
export const sourceOf = (doc: JSONContent | null): string =>
  docToMarkdown(doc && { ...doc, content: (doc.content ?? []).filter((b) => b.type !== 'paragraph' || b.content?.length) });

// El Markdown de una nota editado a mano, de vuelta a documento. Los bloques
// que no cambiaron se quedan como estaban (imágenes, adjuntos, ids de los
// [[enlaces]]…), porque su Markdown no lo guarda todo.
export function sourceToDoc(md: string, prev: JSONContent | null): JSONContent {
  const { doc } = markdownToDoc(md, false);
  const blockMd = (b: JSONContent) => docToMarkdown({ type: 'doc', content: [b] });
  const kept = new Map<string, JSONContent[]>();
  for (const b of prev?.content ?? []) kept.set(blockMd(b), [...(kept.get(blockMd(b)) ?? []), b]);
  return { ...doc, content: (doc.content ?? []).map((b) => kept.get(blockMd(b))?.shift() ?? b) };
}

// Tablas importadas antes de que se entendieran: cada tabla quedó como un solo
// párrafo con las filas unidas por espacios («| a | b | | :-- | :-- | | 1 | 2 |»).
// Se reconocen por la fila de guiones y se convierten en tablas de verdad.
const SEP_CELL = /^\s*:?-{2,}:?\s*$/;

function tableFromRun(text: string): JSONContent | null {
  const t = text.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  const cells = t.slice(1, -1).split(/(?<!\\)\|/);
  const k = cells.findIndex((c) => SEP_CELL.test(c));
  const n = k - 1;
  if (n < 1 || cells[n].trim()) return null;
  if (!cells.slice(k, k + n).every((c) => SEP_CELL.test(c))) return null;
  const rows: string[][] = [cells.slice(0, n)];
  const sep = cells.slice(k, k + n);
  for (let i = k + n; i < cells.length; i += n + 1) {
    if (cells[i].trim()) return null; // entre filas siempre hay «| |»
    const row = cells.slice(i + 1, i + 1 + n);
    if (row.length) rows.push(row);
  }
  const line = (r: string[]) => `| ${r.map((c) => c.trim()).join(' | ')} |`;
  const md = [line(rows[0]), line(sep), ...rows.slice(1).map(line)].join('\n');
  const table = markdownToDoc(md).doc.content?.[0];
  return table?.type === 'table' ? table : null;
}

export function repairTables(doc: JSONContent | null): JSONContent | null {
  if (!doc?.content) return null;
  let changed = false;
  const content = doc.content.map((node) => {
    if (node.type !== 'paragraph' || !node.content?.length) return node;
    const md = docToMarkdown({ type: 'doc', content: [node] }).trim();
    if (!md.includes('|')) return node;
    const table = tableFromRun(md);
    if (!table) return node;
    changed = true;
    return table;
  });
  return changed ? { ...doc, content } : null;
}

// Enlaces importados antes de que se entendieran: los _ de una dirección se
// tomaron por cursiva («…username=APP_MAPFRE_DIRECTO», «[vídeo](…/jose_santiago…
// "título")») y las direcciones sueltas quedaron como texto. Se rehace la línea
// rota desde su Markdown, y a las direcciones sueltas se les pone su enlace.
const LINKISH = new RegExp(`${LINK}|${URL_RE}`, 'gu');
const LINK_ONLY = new RegExp(LINK, 'u');
const URL_G = new RegExp(URL_RE, 'gu');
const hasMark = (n: JSONContent, ...types: string[]) => !!n.marks?.some((m) => types.includes(m.type));

// El Markdown de una línea, con la cursiva como _…_ (así se escribió) y dónde
// van esos _; null si no se sabe escribir.
function lineMd(content: JSONContent[]): { md: string; cuts: number[] } | null {
  let md = '';
  const cuts: number[] = [];
  for (const c of content) {
    if (c.type === 'hardBreak') md += '\n';
    else if (c.type === 'wikilink') md += wikiMd(c);
    else if (c.type !== 'text') return null;
    else if (!hasMark(c, 'italic')) md += marksToMd(c);
    else {
      cuts.push(md.length);
      md += `_${marksToMd({ ...c, marks: c.marks!.filter((m) => m.type !== 'italic') })}_`;
      cuts.push(md.length - 1);
    }
  }
  return { md, cuts };
}

function reparseLine(content: JSONContent[]): JSONContent[] | null {
  const line = lineMd(content);
  if (!line) return null;
  const { md, cuts } = line;
  const split = [...md.matchAll(LINKISH)].some((m) => cuts.some((c) => c >= m.index && c < m.index + m[0].length));
  const raw = content.some((c) => c.type === 'text' && !hasMark(c, 'link', 'code') && LINK_ONLY.test(c.text ?? ''));
  if (!split && !raw) return null;
  return md.split('\n').flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inline(l, [])]);
}

function linkify(n: JSONContent): JSONContent[] {
  if (n.type !== 'text' || !n.text || hasMark(n, 'link', 'code')) return [n];
  const out: JSONContent[] = [];
  const push = (text: string, marks: Mark[]) => text && out.push(marks.length ? { ...n, text, marks } : { type: 'text', text });
  const marks = (n.marks ?? []) as Mark[];
  let last = 0;
  for (const m of n.text.matchAll(URL_G)) {
    const href = m[0].slice(0, m[0].length - urlTail(m[0]).length);
    push(n.text.slice(last, m.index), marks);
    push(href, [...marks, { type: 'link', attrs: { href } }]);
    last = m.index + href.length;
  }
  if (!last) return [n];
  push(n.text.slice(last), marks);
  return out;
}

const INLINE_NODES = ['text', 'hardBreak', 'wikilink'];

export function repairLinks(doc: JSONContent | null): JSONContent | null {
  if (!doc) return null;
  let changed = false;
  const walk = (n: JSONContent): JSONContent => {
    if (!n.content?.length || n.type === 'codeBlock') return n;
    if (!n.content.some((c) => INLINE_NODES.includes(c.type ?? ''))) {
      const content = n.content.map(walk);
      return content.some((c, i) => c !== n.content![i]) ? { ...n, content } : n;
    }
    const before = n.content;
    const content = (reparseLine(before) ?? before).flatMap(linkify);
    if (content.length === before.length && content.every((c, i) => c === before[i])) return n;
    changed = true;
    return { ...n, content };
  };
  const out = walk(doc);
  return changed ? out : null;
}

// Todo lo que se arregla al abrir una nota importada antes; null si nada.
export function repairDoc(doc: JSONContent | null): JSONContent | null {
  const tables = repairTables(doc);
  return repairLinks(tables ?? doc) ?? tables;
}
