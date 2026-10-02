import { Extension, InputRule, Node, mergeAttributes } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import { Fragment, Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { api } from '../api';
import { locale, t } from '../i18n';
import { youtubeEmbed, youtubeId } from './youtube';

export { youtubeId };

// Archivos dentro de las notas. Imágenes, vídeo y audio se ven en el texto;
// cualquier otro (PDF, documentos, hojas de cálculo…) queda como una ficha que
// lo abre o lo descarga. El archivo se sube al servidor y la nota guarda solo
// su dirección.

const player = (name: 'video' | 'audio') =>
  Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ src: { default: null } }),
    parseHTML: () => [{ tag: `${name}[src]` }],
    renderHTML: ({ HTMLAttributes }) => [name, mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata', class: 'note-media' })],
  });

// La extensión que se enseña en la ficha: «PDF», «DOCX»…
export const fileExt = (name: string) => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1].toUpperCase() ?? t('ARCHIVO');

export function fileSize(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n.toLocaleString(locale(), { maximumFractionDigits: n < 10 ? 1 : 0 })} ${units[i]}`;
}

// Los que el navegador sabe enseñar en una pestaña; el resto se descarga.
const viewable = (src: string) => /\.(pdf|txt|png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|ogg|wav|weba|m4a|aac|flac)$/i.test(src);

export function openFile(src: string, name: string) {
  if (viewable(src)) {
    window.open(src, '_blank', 'noopener');
    return;
  }
  const a = document.createElement('a');
  a.href = src;
  a.download = name || '';
  a.click();
}

// Un adjunto cualquiera: una ficha con su tipo, su nombre y su tamaño. Un clic
// lo abre (o lo descarga).
const FileNode = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({
    src: { default: null },
    name: { default: '' },
    size: { default: null },
  }),
  parseHTML: () => [
    {
      tag: 'div[data-note-file]',
      getAttrs: (el) => ({ src: el.dataset.src ?? null, name: el.dataset.name ?? '', size: el.dataset.size ? Number(el.dataset.size) : null }),
    },
  ],
  renderHTML: ({ node }) => {
    const { src, name, size } = node.attrs as { src: string | null; name: string; size: number | null };
    return [
      'div',
      { 'data-note-file': '', 'data-src': src ?? '', 'data-name': name, 'data-size': size ?? '', class: 'note-file', title: viewable(src ?? '') ? t('Abrir') : t('Descargar') },
      ['span', { class: 'note-file-ext' }, fileExt(name)],
      ['span', { class: 'note-file-name' }, name || t('Archivo')],
      ['span', { class: 'note-file-size' }, fileSize(size)],
    ];
  },
  // Su nombre cuenta como texto de la nota: así se encuentra al buscar.
  renderText: ({ node }) => String(node.attrs.name ?? ''),
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClickOn: (_view, _pos, node, _nodePos, event) => {
            if (node.type.name !== 'file' || !node.attrs.src) return false;
            event.preventDefault();
            openFile(node.attrs.src as string, node.attrs.name as string);
            return true;
          },
        },
      }),
    ];
  },
});

// Vídeos de YouTube. Al pegar el enlace solo en una línea, o al escribir
// ![](enlace), !<enlace> o ![[enlace]], se ve el vídeo; la nota guarda el
// enlace tal cual, y al exportar a Markdown sale como ![](enlace).
// Fuera del editor (vistas previas) se enseña su miniatura, que pesa mucho
// menos que un reproductor.
const embedUrl = ({ id, start }: { id: string; start: number }) => `https://www.youtube-nocookie.com/embed/${id}?rel=0${start ? `&start=${start}` : ''}`;

const YouTube = Node.create({
  name: 'youtube',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-youtube]', getAttrs: (el) => ({ src: el.dataset.src ?? null }) }],
  renderHTML: ({ node }) => {
    const src = String(node.attrs.src ?? '');
    const yt = youtubeId(src);
    return [
      'div',
      { 'data-youtube': '', 'data-src': src, class: 'note-youtube' },
      ['a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, yt ? ['img', { src: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`, alt: '', loading: 'lazy' }] : src],
    ];
  },
  renderText: ({ node }) => String(node.attrs.src ?? ''),
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'note-youtube';
      dom.dataset.youtube = '';
      const yt = youtubeId(String(node.attrs.src ?? ''));
      const frame = document.createElement('iframe');
      if (yt) frame.src = embedUrl(yt);
      frame.title = 'YouTube';
      frame.loading = 'lazy';
      frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      dom.append(frame);
      if (editor.isEditable) {
        // Una barrita encima: dejarlo como enlace, o quitarlo.
        const bar = document.createElement('div');
        bar.className = 'note-youtube-bar';
        bar.contentEditable = 'false';
        const button = (label: string, run: (pos: number) => void) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', () => {
            const pos = getPos();
            if (typeof pos === 'number') run(pos);
          });
          bar.append(b);
        };
        button(t('Ver como enlace'), (pos) => {
          const src = String(node.attrs.src ?? '');
          const { schema } = editor.state;
          const para = schema.nodes.paragraph.create(null, schema.text(src, [schema.marks.link.create({ href: src })]));
          editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, para));
          editor.commands.focus();
        });
        button(t('Quitar'), (pos) => {
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
          editor.commands.focus();
        });
        dom.append(bar);
      }
      return { dom, ignoreMutation: () => true, stopEvent: inBar };
    };
    function inBar(e: Event) {
      return e.target instanceof HTMLElement && !!e.target.closest('.note-youtube-bar');
    }
  },
});

// Cambia la línea vacía (o con solo `len` letras escritas) del cursor por el
// vídeo, y sigue escribiendo debajo.
function toVideo(tr: Transaction, src: string): boolean {
  const { $from } = tr.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false;
  const { schema } = tr.doc.type;
  const at = $from.before(1);
  const video = schema.nodes.youtube.create({ src });
  tr.replaceWith(at, at + $from.parent.nodeSize, video);
  const next = at + video.nodeSize;
  if (tr.doc.nodeAt(next)?.type.name !== 'paragraph') tr.insert(next, schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, next + 1)).scrollIntoView();
  return true;
}

// Pegar un enlace de YouTube (o ![](enlace)…) solo en una línea vacía lo
// convierte en el vídeo. Primero entra como enlace y luego se cambia: Ctrl Z
// lo devuelve a enlace. Escribir ![](enlace), !<enlace> o ![[enlace]] solo en
// una línea hace lo mismo (y Retroceso justo después lo deshace).
export const YouTubePaste = Extension.create({
  name: 'youtubePaste',
  priority: 1000,
  addInputRules() {
    const rule = (find: RegExp) =>
      new InputRule({
        find,
        handler: ({ state, range, match }) => {
          const src = youtubeEmbed(match[0]);
          const { tr } = state;
          const $from = tr.doc.resolve(range.from);
          // Solo si la sintaxis ocupa la línea entera.
          if (!src || range.from !== $from.start() || $from.depth !== 1) return null;
          tr.delete(range.from, range.to);
          if (!toVideo(tr, src)) return null;
        },
      });
    return [rule(/^\s*!\[[^\]\n]*\]\([^()\n]+\)$/), rule(/^\s*!<[^\s<>]+>$/), rule(/^\s*!\[\[[^\]\n]+\]\]$/)];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData('text/plain').trim() ?? '';
            const src = text && (youtubeEmbed(text) ?? (!/\s/.test(text) && youtubeId(text) ? text : null));
            if (!src) return false;
            const { $from, empty } = view.state.selection;
            if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size || $from.depth !== 1) return false;
            const { schema } = view.state;
            view.dispatch(view.state.tr.replaceSelectionWith(schema.text(src, [schema.marks.link.create({ href: src })]), false));
            const tr = closeHistory(view.state.tr);
            if (toVideo(tr, src)) view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

// Un enlace de YouTube que ya está en el texto pasa a ser el vídeo. Si la
// línea era solo el enlace, el vídeo ocupa su sitio; si no (está en una frase,
// o es la primera línea de un punto de lista, que ha de ser texto), el enlace
// se queda y el vídeo va justo debajo.
export function linkToVideo(tr: Transaction, from: number, to: number, src: string): boolean {
  const $from = tr.doc.resolve(from);
  const line = $from.parent;
  const holder = $from.node(-1);
  const index = $from.index(-1);
  const { schema } = tr.doc.type;
  const video = schema.nodes.youtube.create({ src });
  const alone = line.textContent.trim() === tr.doc.textBetween(from, to).trim();
  let at: number;
  if (alone && holder.canReplaceWith(index, index + 1, video.type)) {
    at = $from.before();
    tr.replaceWith(at, $from.after(), video);
  } else if (holder.canReplaceWith(index + 1, index + 1, video.type)) {
    at = $from.after();
    tr.insert(at, video);
  } else return false;
  const next = at + video.nodeSize;
  if ($from.depth === 1 && !tr.doc.nodeAt(next)) tr.insert(next, schema.nodes.paragraph.create());
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(next, tr.doc.content.size)))).scrollIntoView();
  return true;
}

export const mediaNodes = [
  Image.configure({ allowBase64: false, HTMLAttributes: { class: 'note-media', loading: 'lazy' } }),
  player('video'),
  player('audio'),
  FileNode,
  YouTube,
];

// Una nota con solo una imagen o un adjunto no está vacía.
export const hasMedia = (bodyJson: string | null) => !!bodyJson && /"type":"(image|video|audio|file|youtube)"/.test(bodyJson);

// Lo que se ve dentro de la nota (sin SVG, que puede llevar código).
export const isMedia = (f: File) => /^(image|video|audio)\//.test(f.type) && f.type !== 'image/svg+xml';

// Sube los archivos y devuelve los nodos listos para meter en un documento.
export async function uploadMedia(files: File[]) {
  const done = await Promise.all(files.map((f) => api.uploadMedia(f)));
  return done.map(({ url, kind }, i) =>
    kind === 'file' ? { type: 'file', attrs: { src: url, name: files[i].name, size: files[i].size } } : { type: kind, attrs: { src: url } },
  );
}

function insert(view: EditorView, files: File[], pos: number | null, onError: (e: unknown) => void) {
  uploadMedia(files)
    .then((nodes) => {
      if (view.isDestroyed) return;
      const { schema, tr } = view.state;
      const content = Fragment.from(nodes.map((n) => schema.nodeFromJSON(n)));
      view.dispatch(pos === null ? tr.replaceSelection(new Slice(content, 0, 0)) : tr.insert(Math.min(pos, tr.doc.content.size), content));
      view.focus();
    })
    .catch(onError);
}

// El botón «Adjuntar»: donde esté el cursor.
export const attachFiles = (view: EditorView, files: File[], onError: (e: unknown) => void) => insert(view, files, null, onError);

// Pegar o soltar archivos en el editor.
export const MediaUpload = Extension.create<{ onError: (e: unknown) => void }>({
  name: 'mediaUpload',
  addOptions: () => ({ onError: () => {} }),
  addProseMirrorPlugins() {
    const { onError } = this.options;
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (!files.length) return false;
            insert(view, files, null, onError);
            return true;
          },
          handleDrop: (view, event) => {
            const files = [...(event.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            event.preventDefault();
            // Entre bloques, detrás del párrafo sobre el que se suelta.
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const $p = hit && view.state.doc.resolve(hit.pos);
            insert(view, files, $p ? ($p.depth ? $p.after(1) : $p.pos) : null, onError);
            return true;
          },
        },
      }),
    ];
  },
});
