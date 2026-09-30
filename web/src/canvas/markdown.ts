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
      // La puntuación del final de la frase no es parte de la dirección.
      const tail = /[.,;:!?)\]]+$/.exec(tok)?.[0] ?? '';
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

// Una lista y lo que cuelga de ella: lo más sangrado va dentro del punto de
// encima (así, una casilla sangrada bajo otra es su subtarea).
function parseList(lines: string[], start: number, links: string[]): [JSONContent, number] {
  const first = listLine(lines[start])!;
  const items: JSONContent[] = [];
  let i = start;
  while (i < lines.length) {
    const l = listLine(lines[i]);
    if (!l || l.indent < first.indent || (l.indent === first.indent && l.type !== first.type)) break;
    if (l.indent > first.indent && items.length) {
      const [sub, next] = parseList(lines, i, links);
      items[items.length - 1].content!.push(sub);
      i = next;
      continue;
    }
    const status = BOX_STATUS[l.box ?? ''];
    items.push(
      first.type === 'taskList'
        ? { type: 'taskItem', attrs: { checked: /x/i.test(l.box ?? ''), ...(status ? { status } : {}) }, content: [para(l.text, links)] }
        : { type: 'listItem', content: [para(l.text, links)] },
    );
    i++;
  }
  return [{ type: first.type, content: items }, i];
}

export function markdownToDoc(md: string): { doc: JSONContent; links: string[]; heading: string | null } {
  const links: string[] = [];
  let heading: string | null = null;
  const lines = md.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
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
      heading ??= h[2].trim();
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: inline(h[2], links) });
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
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
      const [list, next] = parseList(lines, i, links);
      content.push(list);
      i = next;
      continue;
    }
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(text.length && TABLE_ROW.test(lines[i]))) text.push(lines[i++].trim());
    content.push(para(text.join(' '), links));
  }
  return { doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }, links, heading };
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
            const head = `${indent}${n.type === 'orderedList' ? `${i + 1}.` : '-'} ${first ? inl(first) : ''}`;
            return [head, ...rest.map((r) => block(r, indent + '  '))].join('\n');
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
      case 'codeBlock':
        return '```\n' + inl(n) + '\n```';
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
      default:
        return (n.content ?? []).map((c) => block(c, indent)).join('\n\n');
    }
  };
  return (doc.content ?? []).map((b) => block(b)).join('\n\n').trim();
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
