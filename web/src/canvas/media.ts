import { Extension, Node, mergeAttributes } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { api } from '../api';

// Imágenes, vídeo y audio dentro de las notas. El archivo se sube al servidor y
// la nota guarda solo su dirección.

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

export const mediaNodes = [
  Image.configure({ allowBase64: false, HTMLAttributes: { class: 'note-media', loading: 'lazy' } }),
  player('video'),
  player('audio'),
];

// Una nota con solo una imagen no está vacía.
export const hasMedia = (bodyJson: string | null) => !!bodyJson && /"type":"(image|video|audio)"/.test(bodyJson);

export const isMedia = (f: File) => /^(image|video|audio)\//.test(f.type) && f.type !== 'image/svg+xml';

// Sube los archivos y devuelve los nodos listos para meter en un documento.
export async function uploadMedia(files: File[]) {
  const done = await Promise.all(files.map((f) => api.uploadMedia(f)));
  return done.map(({ url, kind }) => ({ type: kind === 'image' ? 'image' : kind, attrs: { src: url } }));
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
            const files = [...(event.clipboardData?.files ?? [])].filter(isMedia);
            if (!files.length) return false;
            insert(view, files, null, onError);
            return true;
          },
          handleDrop: (view, event) => {
            const files = [...(event.dataTransfer?.files ?? [])].filter(isMedia);
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
