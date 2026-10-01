import { Extension, Node, mergeAttributes } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { api } from '../api';

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
export const fileExt = (name: string) => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1].toUpperCase() ?? 'ARCHIVO';

export function fileSize(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n.toLocaleString('es', { maximumFractionDigits: n < 10 ? 1 : 0 })} ${units[i]}`;
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
      { 'data-note-file': '', 'data-src': src ?? '', 'data-name': name, 'data-size': size ?? '', class: 'note-file', title: viewable(src ?? '') ? 'Abrir' : 'Descargar' },
      ['span', { class: 'note-file-ext' }, fileExt(name)],
      ['span', { class: 'note-file-name' }, name || 'Archivo'],
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

export const mediaNodes = [
  Image.configure({ allowBase64: false, HTMLAttributes: { class: 'note-media', loading: 'lazy' } }),
  player('video'),
  player('audio'),
  FileNode,
];

// Una nota con solo una imagen o un adjunto no está vacía.
export const hasMedia = (bodyJson: string | null) => !!bodyJson && /"type":"(image|video|audio|file)"/.test(bodyJson);

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
