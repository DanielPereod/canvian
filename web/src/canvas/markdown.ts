import type { JSONContent } from '@tiptap/react';

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
    String.raw`\[\[[^\]]+\]\]`,
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
    else if (tok.startsWith('[[')) {
      // [[Nota|alias]] → se lee el alias y se recuerda el enlace para unir las notas.
      const [target, alias] = tok.slice(2, -2).split('|');
      links.push(target.split('#')[0].trim());
      push(alias ?? target, [{ type: 'bold' }]);
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

const para = (text: string, links: string[]): JSONContent => {
  const content = inline(text, links);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

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
      content.push({ type: 'heading', attrs: { level: Math.min(3, h[1].length) }, content: inline(h[2], links) });
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
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: JSONContent[] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        // Casillas de tareas (- [ ] / - [x]) se importan como texto con su marca.
        const text = lines[i++].replace(bullet, '').replace(/^\[( |x|X)\]\s*/, (_, x) => (x.trim() ? '✓ ' : '☐ '));
        items.push({ type: 'listItem', content: [para(text, links)] });
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
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
      : (n.content ?? []).map(block).join(n.type === 'tableRow' ? ' · ' : ['doc', 'bulletList', 'orderedList', 'blockquote', 'listItem', 'table'].includes(n.type ?? '') ? '\n' : '');
  return block(doc).trim();
}

function marksToMd(n: JSONContent): string {
  let t = n.text ?? '';
  for (const m of n.marks ?? []) {
    if (m.type === 'bold') t = `**${t}**`;
    else if (m.type === 'italic') t = `*${t}*`;
    else if (m.type === 'code') t = `\`${t}\``;
    else if (m.type === 'strike') t = `~~${t}~~`;
    else if (m.type === 'link') t = t === m.attrs?.href ? t : `[${t}](${String(m.attrs?.href ?? '')})`;
  }
  return t;
}

export function docToMarkdown(doc: JSONContent | null): string {
  if (!doc) return '';
  const inl = (n: JSONContent) => (n.content ?? []).map((c) => (c.type === 'hardBreak' ? '\n' : marksToMd(c))).join('');
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
