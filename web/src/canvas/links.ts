import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { splitWiki } from './obsidian';
import { embedJson } from './youtube';

// Lo que se hace con un enlace desde su menú (clic derecho): abrirlo, volver a
// escribirlo en Markdown para editarlo, quitarlo o verlo incrustado.

export type LinkHit = { from: number; to: number; kind: 'web' | 'wiki'; href: string; text: string; id?: string | null };

// El enlace (web o [[nota]]) que hay en `pos`, entero.
export function linkAt(state: EditorState, pos: number): LinkHit | null {
  const wiki = state.doc.nodeAt(pos);
  if (wiki?.type.name === 'wikilink') return { from: pos, to: pos + wiki.nodeSize, kind: 'wiki', href: String(wiki.attrs.target), text: String(wiki.attrs.alias ?? ''), id: wiki.attrs.id ?? null };
  const link = state.schema.marks.link;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!link || !parent.isTextblock) return null;
  // El trozo de texto con el enlace bajo el cursor, y sus vecinos con el mismo.
  const start = $pos.start();
  const kids: { from: number; to: number; href: string | null; text: string }[] = [];
  parent.forEach((n, off) => {
    const m = n.marks.find((mk) => mk.type === link);
    kids.push({ from: start + off, to: start + off + n.nodeSize, href: m ? String(m.attrs.href) : null, text: n.text ?? '' });
  });
  const i = kids.findIndex((k) => pos >= k.from && pos < k.to && k.href);
  if (i < 0) return null;
  const href = kids[i].href!;
  let a = i;
  let b = i;
  while (a > 0 && kids[a - 1].href === href) a--;
  while (b < kids.length - 1 && kids[b + 1].href === href) b++;
  return { from: kids[a].from, to: kids[b].to, kind: 'web', href, text: kids.slice(a, b + 1).map((k) => k.text).join('') };
}

// Lo que se ve al incrustarlo: un vídeo de YouTube, una imagen, la ficha de la
// web o, si es un [[enlace]], la otra nota entera.
export function embedOf(state: EditorState, hit: LinkHit): PMNode | null {
  const json = embedJson(hit.kind === 'wiki' ? { note: hit.href } : { url: hit.href, alt: '' }, hit.id ?? null);
  if (!json || !state.schema.nodes[json.type]) return null;
  try {
    return state.schema.nodeFromJSON(json);
  } catch {
    return null;
  }
}

// Pone el bloque en lugar del párrafo que empieza en `at` (si el sitio lo
// admite; el primer párrafo de un punto de lista no se puede quitar) o justo
// debajo. Devuelve dónde acaba.
export function placeBlock(tr: Transaction, at: number, block: PMNode, replace: boolean): number {
  const para = tr.doc.nodeAt(at)!;
  const $at = tr.doc.resolve(at);
  const i = $at.index();
  if (replace && $at.parent.canReplace(i, i + 1, Fragment.from(block))) {
    tr.replaceWith(at, at + para.nodeSize, block);
    return at + block.nodeSize;
  }
  const after = at + para.nodeSize;
  tr.insert(after, block);
  return after + block.nodeSize;
}

// Deja el cursor en una línea vacía debajo de `pos` (creándola si no la hay).
export function caretBelow(tr: Transaction, pos: number) {
  const { paragraph } = tr.doc.type.schema.nodes;
  const next = tr.doc.nodeAt(pos);
  if (next?.type !== paragraph || next.content.size) {
    const $p = tr.doc.resolve(pos);
    if (!$p.parent.canReplaceWith($p.index(), $p.index(), paragraph)) return;
    tr.insert(pos, paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
}

// El enlace pasa a verse incrustado. Si delante tiene un «!» (de ![](…) o
// ![[…]] importados), se va con él.
export function embedLink(view: EditorView, hit: LinkHit) {
  const { state } = view;
  const block = embedOf(state, hit);
  if (!block) return;
  const $from = state.doc.resolve(hit.from);
  const bang = $from.parentOffset > 0 && state.doc.textBetween(hit.from - 1, hit.from) === '!' ? 1 : 0;
  const tr = state.tr.delete(hit.from - bang, hit.to);
  const at = $from.before();
  const para = tr.doc.nodeAt(at)!;
  let alone = !para.textContent.trim();
  para.forEach((n) => (alone &&= n.isText));
  const $at = tr.doc.resolve(at);
  const replace = alone && $at.parent.canReplace($at.index(), $at.index() + 1, Fragment.from(block));
  // La línea no se puede quitar (es la de un punto de lista): el enlace se queda en ella.
  if (alone && !replace) tr.insert(at + 1, state.doc.slice(hit.from, hit.to).content);
  const end = placeBlock(tr, at, block, replace);
  view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, end - block.nodeSize)));
  view.focus();
}

// Vuelve a escribir el enlace como Markdown, con el cursor al final de la
// dirección (o de la nota): al salir de él vuelve a ser un enlace.
export function editLink(view: EditorView, hit: LinkHit) {
  const { state } = view;
  const wiki = hit.kind === 'wiki';
  const md = wiki ? `[[${hit.href}${hit.text ? `|${hit.text}` : ''}]]` : `[${hit.text || hit.href}](${hit.href})`;
  const tr = state.tr.replaceWith(hit.from, hit.to, state.schema.text(md));
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, hit.from + md.length - (wiki ? 2 : 1))));
  view.focus();
}

// Deja solo el texto.
export function unlink(view: EditorView, hit: LinkHit) {
  const { state } = view;
  const text = hit.text || splitWiki(hit.href).note || hit.href;
  view.dispatch(hit.kind === 'wiki' ? state.tr.replaceWith(hit.from, hit.to, state.schema.text(text)) : state.tr.removeMark(hit.from, hit.to, state.schema.marks.link));
  view.focus();
}
