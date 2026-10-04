import Image from '@tiptap/extension-image';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { t } from '../i18n';
import { formatCrop, isWhole, parseCrop, type Crop } from '../../../server/src/doc/image';

// Las imágenes de las notas: se cambian de tamaño con las asas de los lados y
// se recortan con un marco. El archivo queda igual; la nota guarda el ancho y
// el trozo que se ve (ver server/src/doc/image.ts), y «Restablecer» lo quita.

const MIN = 48;

type Attrs = { src: string; alt: string | null; title: string | null; width: number | null; crop: string | null; blockId?: string | null };

// Cómo se pinta: el marco recorta la imagen, que se estira y se mueve dentro.
// Sirve igual para el editor y para las vistas previas.
function frameStyle(crop: Crop | null) {
  if (!crop?.ratio || isWhole(crop)) return { frame: '', img: '' };
  const ar = (crop.w * crop.ratio) / crop.h;
  return {
    frame: `aspect-ratio:${ar.toFixed(4)}`,
    img: `width:${(100 / crop.w).toFixed(3)}%;left:${((-crop.x / crop.w) * 100).toFixed(3)}%;top:${((-crop.y / crop.h) * 100).toFixed(3)}%`,
  };
}

const wrapStyle = (width: number | null) => (width ? `width:${width}px` : '');

export const NoteImage = Image.extend({
  addInputRules: () => [],
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-width') || el.getAttribute('width')) || null,
        renderHTML: () => ({}),
      },
      crop: {
        default: null,
        parseHTML: (el) => {
          const c = parseCrop(el.getAttribute('data-crop'));
          return c ? formatCrop(c) : null;
        },
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-note-image]',
        getAttrs: (el) => {
          const img = el.querySelector('img');
          return img ? { src: img.getAttribute('src'), alt: img.getAttribute('alt'), title: img.getAttribute('title') } : false;
        },
      },
      ...(this.parent?.() ?? []),
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { width, crop: raw, src, alt, title } = node.attrs as Attrs;
    const crop = parseCrop(raw);
    if (!width && !crop) return ['img', { ...HTMLAttributes, class: 'note-media', loading: 'lazy' }];
    const s = frameStyle(crop);
    return [
      'div',
      {
        'data-note-image': '',
        'data-width': width ?? '',
        'data-crop': raw ?? '',
        ...(HTMLAttributes['data-block-id'] ? { 'data-block-id': HTMLAttributes['data-block-id'] } : {}),
        class: `note-image${s.frame ? ' is-cropped' : ''}`,
        style: wrapStyle(width),
      },
      ['div', { class: 'note-image-frame', style: s.frame }, ['img', { src, alt: alt ?? '', title: title ?? undefined, loading: 'lazy', style: s.img }]],
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => imageView(node, getPos, editor as Editor);
  },
});

function imageView(initial: PMNode, getPos: () => number | undefined, editor: Editor) {
  let node = initial;
  const dom = document.createElement('div');
  dom.className = 'note-image';
  dom.dataset.noteImage = '';
  const frame = document.createElement('div');
  frame.className = 'note-image-frame';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.draggable = false;
  frame.append(img);
  dom.append(frame);

  const attrs = () => node.attrs as Attrs;
  const save = (patch: Partial<Attrs>) => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }));
  };

  // Mientras se arrastra un asa o el marco, el bloque no se arrastra.
  const hold = (e: PointerEvent, move: (e: PointerEvent) => void, end: () => void) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Sin captura también vale: se escucha en la ventana.
    }
    dom.draggable = false;
    dom.classList.add('is-busy');
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dom.draggable = true;
      dom.classList.remove('is-busy');
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const block = (el: HTMLElement) => {
    el.contentEditable = 'false';
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
    return el;
  };

  // El ancho que cabe: el de la columna donde está.
  const room = () => (dom.parentElement?.clientWidth || editor.view.dom.clientWidth || 9999);

  function paint() {
    const a = attrs();
    if (img.getAttribute('src') !== a.src) img.src = a.src;
    img.alt = a.alt ?? '';
    if (a.title) img.title = a.title;
    if (a.blockId) dom.dataset.blockId = a.blockId;
    else delete dom.dataset.blockId;
    if (cropping) return;
    const crop = parseCrop(a.crop);
    const s = frameStyle(crop);
    dom.style.cssText = wrapStyle(a.width);
    dom.classList.toggle('is-cropped', !!s.frame);
    dom.classList.toggle('has-width', !!a.width);
    frame.style.cssText = s.frame;
    img.style.cssText = s.img;
    reset.hidden = !a.width && !a.crop;
  }

  // Lo que se guardó antes de saber la forma de la imagen (venía de Markdown sin
  // proporción): se completa en cuanto carga, sin que cuente para deshacer.
  img.addEventListener('load', () => {
    const crop = parseCrop(attrs().crop);
    if (!crop || crop.ratio || !img.naturalWidth || !editor.isEditable) return;
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const ratio = img.naturalWidth / img.naturalHeight;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, crop: formatCrop({ ...crop, ratio }) }).setMeta('addToHistory', false));
  });

  // Asas a izquierda y derecha: cambian el ancho, la altura sigue la proporción.
  for (const side of ['l', 'r'] as const) {
    const h = block(document.createElement('div'));
    h.className = `note-image-handle note-image-handle-${side}`;
    h.title = t('Arrastra para cambiar el tamaño');
    h.addEventListener('pointerdown', (e) => {
      if (!editor.isEditable || cropping) return;
      const x0 = e.clientX;
      const w0 = dom.getBoundingClientRect().width;
      const max = room();
      let w = w0;
      hold(
        e,
        (m) => {
          const dx = (m.clientX - x0) * (side === 'r' ? 1 : -1);
          w = Math.round(Math.min(max, Math.max(MIN, w0 + dx)));
          dom.style.width = `${w}px`;
          dom.classList.add('has-width');
        },
        () => {
          if (Math.abs(w - w0) >= 1) save({ width: w });
          else paint();
        },
      );
    });
    dom.append(h);
  }

  // La barrita: recortar y restablecer; al recortar, aplicar o cancelar.
  const bar = block(document.createElement('div'));
  bar.className = 'note-youtube-bar note-image-bar';
  const button = (label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    bar.append(b);
    return b;
  };
  const cropBtn = button(t('Recortar'), () => startCrop());
  const reset = button(t('Restablecer'), () => save({ width: null, crop: null }));
  const apply = button(t('Aplicar'), () => endCrop(true));
  const cancel = button(t('Cancelar'), () => endCrop(false));
  apply.hidden = cancel.hidden = true;
  if (editor.isEditable) dom.append(bar);

  // El modo recorte: la imagen entera, con un marco que se mueve y se estira.
  let cropping = false;
  let box: Crop = { x: 0, y: 0, w: 1, h: 1, ratio: null };
  const overlay = block(document.createElement('div'));
  overlay.className = 'note-image-crop';
  // La sombra fuera del marco va en su propia capa recortada, para que las asas
  // del marco puedan asomar por los bordes de la imagen.
  const shade = document.createElement('div');
  shade.className = 'note-image-crop-shade';
  const hole = document.createElement('div');
  shade.append(hole);
  const rect = document.createElement('div');
  rect.className = 'note-image-crop-box';
  overlay.append(shade, rect);
  const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
  for (const edge of EDGES) {
    const g = document.createElement('div');
    g.className = `note-image-crop-grip grip-${edge}`;
    g.dataset.edge = edge;
    rect.append(g);
  }
  const drawBox = () => {
    for (const el of [rect, hole]) {
      el.style.left = `${box.x * 100}%`;
      el.style.top = `${box.y * 100}%`;
      el.style.width = `${box.w * 100}%`;
      el.style.height = `${box.h * 100}%`;
    }
  };
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const SMALL = 0.04;
  rect.addEventListener('pointerdown', (e) => {
    const edge = (e.target as HTMLElement).dataset.edge ?? '';
    const r = overlay.getBoundingClientRect();
    const start = { ...box };
    const x0 = e.clientX;
    const y0 = e.clientY;
    hold(
      e,
      (m) => {
        const dx = (m.clientX - x0) / r.width;
        const dy = (m.clientY - y0) / r.height;
        if (!edge) {
          box = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
        } else {
          let { x, y, w, h } = start;
          if (edge.includes('w')) {
            const nx = clamp(x + dx, 0, x + w - SMALL);
            w += x - nx;
            x = nx;
          }
          if (edge.includes('e')) w = clamp(w + dx, SMALL, 1 - x);
          if (edge.includes('n')) {
            const ny = clamp(y + dy, 0, y + h - SMALL);
            h += y - ny;
            y = ny;
          }
          if (edge.includes('s')) h = clamp(h + dy, SMALL, 1 - y);
          box = { ...box, x, y, w, h };
        }
        drawBox();
      },
      () => {},
    );
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    endCrop(e.key === 'Enter');
  };

  // Ancho que tiene ahora la imagen entera (sin recorte) en pantalla.
  let fullWidth = 0;
  function startCrop() {
    if (cropping || !editor.isEditable) return;
    const crop = parseCrop(attrs().crop);
    const shown = dom.getBoundingClientRect().width;
    fullWidth = Math.min(room(), Math.round(crop && !isWhole(crop) ? shown / crop.w : shown));
    box = crop ?? { x: 0, y: 0, w: 1, h: 1, ratio: null };
    cropping = true;
    dom.classList.add('is-cropping');
    dom.classList.remove('is-cropped');
    dom.style.cssText = `width:${fullWidth}px`;
    frame.style.cssText = '';
    img.style.cssText = '';
    frame.append(overlay);
    drawBox();
    cropBtn.hidden = reset.hidden = true;
    apply.hidden = cancel.hidden = false;
    document.addEventListener('keydown', onKey, true);
  }
  function endCrop(keep: boolean) {
    if (!cropping) return;
    cropping = false;
    dom.classList.remove('is-cropping');
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    cropBtn.hidden = false;
    apply.hidden = cancel.hidden = true;
    if (keep) {
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
      const whole = isWhole(box);
      // El trozo conserva su escala: se ve igual de grande que dentro de la entera.
      const width = whole ? attrs().width && fullWidth : Math.max(MIN, Math.round(fullWidth * box.w));
      save({ crop: whole ? null : formatCrop({ ...box, ratio }), width: width || null });
    }
    paint();
  }

  paint();

  return {
    dom,
    update(next: PMNode) {
      if (next.type !== node.type) return false;
      node = next;
      paint();
      return true;
    },
    stopEvent: (e: Event) => e.target instanceof HTMLElement && !!e.target.closest('.note-image-bar, .note-image-handle, .note-image-crop'),
    ignoreMutation: () => true,
    deselectNode() {
      dom.classList.remove('ProseMirror-selectednode');
      // Al irse a otro sitio, el recorte se queda (fuera de la actualización en curso).
      if (cropping) setTimeout(() => endCrop(true));
    },
    selectNode() {
      dom.classList.add('ProseMirror-selectednode');
    },
    destroy() {
      document.removeEventListener('keydown', onKey, true);
    },
  };
}
