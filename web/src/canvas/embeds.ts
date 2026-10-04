import { Node, type Editor } from '@tiptap/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { api } from '../api';
import { t } from '../i18n';
import { splitWiki } from './obsidian';

// Enlaces vistos incrustados: la ficha de una web (título, texto, imagen) y
// otra nota entera dentro de esta, como ![[Nota]] en Obsidian.

// ── De dónde salen las notas incrustadas ─────────────────────────────
// La hoja dice cómo encontrar una nota, abrirla y pintar su texto; las notas
// incrustadas que ya se ven se repintan cuando cambia algo.
export type EmbeddedNote = { id: string; title: string; bodyJson: string | null };
// `section`: lo de detrás de «#» (![[Nota#^abc123]] incrusta solo ese bloque).
type NoteSource = { find: (id: string | null, target: string) => EmbeddedNote | null; open: (id: string, section: string | null) => void; html: (bodyJson: string | null, section: string | null) => string };
let source: NoteSource | null = null;
const watchers = new Set<() => void>();
export function setNoteSource(s: NoteSource | null) {
  source = s;
  watchers.forEach((f) => f());
}

// La barrita encima de un bloque incrustado: volver a enlace, o quitarlo.
function embedBar(editor: Editor, getPos: () => number | undefined, node: PMNode, inline: (schema: Schema) => PMNode, extra: [string, () => void][] = []) {
  const bar = document.createElement('div');
  bar.className = 'note-youtube-bar';
  bar.contentEditable = 'false';
  const button = (label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    bar.append(b);
  };
  const at = (run: (pos: number) => void) => () => {
    const pos = getPos();
    if (typeof pos === 'number') run(pos);
  };
  for (const [label, run] of extra) button(label, run);
  button(
    t('Ver como enlace'),
    at((pos) => {
      const { schema } = editor.state;
      editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph.create(null, inline(schema))));
      editor.commands.focus();
    }),
  );
  button(
    t('Quitar'),
    at((pos) => {
      editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
      editor.commands.focus();
    }),
  );
  return bar;
}
const inBar = (e: Event) => e.target instanceof HTMLElement && !!e.target.closest('.note-youtube-bar');

// ── Ficha de una web ─────────────────────────────────────────────────
const hostOf = (href: string) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
};

type CardAttrs = { href: string; title: string | null; description: string | null; image: string | null; site: string | null };
function fillCard(el: HTMLElement, a: CardAttrs) {
  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'note-bookmark-text';
  const title = document.createElement('span');
  title.className = 'note-bookmark-title';
  title.textContent = a.title || a.href;
  text.append(title);
  if (a.description) {
    const d = document.createElement('span');
    d.className = 'note-bookmark-desc';
    d.textContent = a.description;
    text.append(d);
  }
  const site = document.createElement('span');
  site.className = 'note-bookmark-site';
  site.textContent = a.site || hostOf(a.href);
  text.append(site);
  el.append(text);
  if (a.image) {
    const img = document.createElement('img');
    img.className = 'note-bookmark-img';
    img.src = a.image;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    el.append(img);
  }
}

export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ href: { default: '' }, title: { default: null }, description: { default: null }, image: { default: null }, site: { default: null } }),
  parseHTML: () => [
    {
      tag: 'a[data-bookmark]',
      getAttrs: (el) => ({ href: el.getAttribute('href') ?? '', title: el.dataset.title || null, description: el.dataset.description || null, image: el.dataset.image || null, site: el.dataset.site || null }),
    },
  ],
  renderHTML: ({ node }) => {
    const a = node.attrs as CardAttrs;
    return [
      'a',
      { 'data-bookmark': '', href: a.href, target: '_blank', rel: 'noopener noreferrer', class: 'note-bookmark', 'data-title': a.title ?? '', 'data-description': a.description ?? '', 'data-image': a.image ?? '', 'data-site': a.site ?? '' },
      ['span', { class: 'note-bookmark-text' }, ['span', { class: 'note-bookmark-title' }, a.title || a.href], ['span', { class: 'note-bookmark-site' }, a.site || hostOf(a.href)]],
      ...(a.image ? [['img', { class: 'note-bookmark-img', src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }]] : []),
    ];
  },
  renderText: ({ node }) => String(node.attrs.title || node.attrs.href),
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'note-bookmark-wrap';
      const card = document.createElement('a');
      card.className = 'note-bookmark';
      card.href = node.attrs.href;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.contentEditable = 'false';
      fillCard(card, node.attrs as CardAttrs);
      // Un clic abre la web en otra pestaña.
      card.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(node.attrs.href, '_blank', 'noopener,noreferrer');
      });
      dom.append(card);
      if (editor.isEditable) {
        dom.append(embedBar(editor, getPos, node, (schema) => schema.text(node.attrs.href, [schema.marks.link.create({ href: node.attrs.href })])));
        // La primera vez, el servidor lee la página y la ficha se guarda en la nota.
        if (!node.attrs.title && !node.attrs.site) {
          api
            .unfurl(node.attrs.href)
            .then((c) => {
              const pos = getPos();
              if (typeof pos !== 'number' || editor.isDestroyed || editor.state.doc.nodeAt(pos) !== node) return;
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title: c.title, description: c.description, image: c.image, site: c.site ?? hostOf(node.attrs.href) }).setMeta('addToHistory', false));
            })
            .catch(() => {});
        }
      }
      return { dom, ignoreMutation: () => true, stopEvent: inBar };
    };
  },
});

// ── Otra nota dentro de esta ─────────────────────────────────────────
export const NoteEmbed = Node.create({
  name: 'noteEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ id: { default: null }, target: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-note-embed]', getAttrs: (el) => ({ id: el.dataset.id || null, target: el.dataset.target ?? '' }) }],
  // Fuera del editor (vistas previas), solo su nombre: así no se mete una
  // nota dentro de otra sin fin.
  renderHTML: ({ node }) => ['div', { 'data-note-embed': '', 'data-id': node.attrs.id ?? '', 'data-target': node.attrs.target, class: 'note-embed' }, ['div', { class: 'note-embed-head' }, `↳ ${splitWiki(node.attrs.target).note}`]],
  renderText: ({ node }) => splitWiki(String(node.attrs.target)).note,
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'note-embed';
      dom.contentEditable = 'false';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'note-embed-head';
      const body = document.createElement('div');
      body.className = 'note-embed-body prose';
      dom.append(head, body);
      let found: EmbeddedNote | null = null;
      const paint = () => {
        found = source?.find(node.attrs.id, node.attrs.target) ?? null;
        const { note, section } = splitWiki(node.attrs.target);
        head.textContent = `↳ ${found?.title || note}${section && !section.startsWith('^') ? ` › ${section}` : ''}`;
        body.innerHTML = found ? source!.html(found.bodyJson, section) || `<p class="note-embed-empty">${t('Nota vacía')}</p>` : `<p class="note-embed-empty">${t('Esta nota aún no existe')}</p>`;
      };
      paint();
      watchers.add(paint);
      head.addEventListener('mousedown', (e) => e.preventDefault());
      head.addEventListener('click', () => found && source?.open(found.id, splitWiki(node.attrs.target).section));
      if (editor.isEditable)
        dom.append(
          embedBar(editor, getPos, node, (schema) => schema.nodes.wikilink.create({ id: node.attrs.id, target: node.attrs.target, alias: null }), [[t('Abrir'), () => found && source?.open(found.id, splitWiki(node.attrs.target).section)]]),
        );
      return { dom, ignoreMutation: () => true, stopEvent: (e: Event) => inBar(e) || (e.target instanceof HTMLElement && !!e.target.closest('.note-embed-head')), destroy: () => watchers.delete(paint) };
    };
  },
});

export const embedNodes = [Bookmark, NoteEmbed];
