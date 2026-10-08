import type { CSSProperties } from 'react';

// La portada de una nota, como en Notion. Se guarda como texto en la nota:
//   «grad:<id>»          uno de los degradados de abajo
//   «<url>#y=<0-100>»    una imagen (subida, /api/media/…, o de la web) y la
//                        altura de la imagen que se ve, en %
// Sin portada, null.

export const GRADIENTS: { id: string; css: string }[] = [
  { id: 'piedra', css: 'linear-gradient(135deg, #d8d3cb 0%, #a39c91 100%)' },
  { id: 'grafito', css: 'linear-gradient(135deg, #2a2a2c 0%, #5b5b60 100%)' },
  { id: 'salvia', css: 'linear-gradient(135deg, #b7c2ae 0%, #5f6f5b 100%)' },
  { id: 'mar', css: 'linear-gradient(135deg, #a9c7cc 0%, #3e6872 100%)' },
  { id: 'arena', css: 'linear-gradient(135deg, #ead8b9 0%, #bf8a5e 100%)' },
  { id: 'arcilla', css: 'linear-gradient(135deg, #d2a99e 0%, #7a4c47 100%)' },
  { id: 'ocaso', css: 'linear-gradient(135deg, #3c4862 0%, #9a86a6 100%)' },
  { id: 'noche', css: 'linear-gradient(160deg, #0e1014 0%, #2b3242 100%)' },
];

export type Cover = { kind: 'gradient'; id: string; css: string } | { kind: 'image'; src: string; y: number };

export function parseCover(raw: string | null | undefined): Cover | null {
  if (!raw) return null;
  if (raw.startsWith('grad:')) {
    const g = GRADIENTS.find((x) => x.id === raw.slice(5)) ?? GRADIENTS[0];
    return { kind: 'gradient', id: g.id, css: g.css };
  }
  const at = raw.lastIndexOf('#y=');
  const y = at >= 0 ? Number(raw.slice(at + 3)) : 50;
  return { kind: 'image', src: at >= 0 ? raw.slice(0, at) : raw, y: Number.isFinite(y) ? Math.min(100, Math.max(0, y)) : 50 };
}

export const imageCover = (src: string, y = 50) => `${src}#y=${Math.round(y)}`;

// Al añadir una, sale un degradado al azar (luego se cambia si se quiere).
export const randomCover = () => `grad:${GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)].id}`;

// Solo imágenes de esta app o de la web (nada de javascript: ni data:).
export const okImageUrl = (url: string) => /^(https?:\/\/|\/api\/media\/)\S+$/i.test(url.trim());

export const coverStyle = (c: Cover): CSSProperties =>
  c.kind === 'gradient' ? { background: c.css } : { backgroundImage: `url("${c.src.replace(/"/g, '%22')}")`, backgroundPosition: `50% ${c.y}%` };

// La primera imagen del texto de una nota (su JSON), para la tarjeta de la
// galería. Se recuerda por texto: la galería repinta a menudo.
const firstImages = new Map<string, string | null>();
export function firstImage(bodyJson: string | null | undefined): string | null {
  if (!bodyJson || !/"type"\s*:\s*"image"/.test(bodyJson)) return null;
  let hit = firstImages.get(bodyJson);
  if (hit !== undefined) return hit;
  hit = null;
  try {
    const walk = (n: { type?: string; attrs?: { src?: unknown }; content?: unknown[] }): boolean => {
      if (n?.type === 'image' && typeof n.attrs?.src === 'string' && okImageUrl(n.attrs.src)) return !!(hit = n.attrs.src);
      return Array.isArray(n?.content) && n.content.some((c) => walk(c as typeof n));
    };
    walk(JSON.parse(bodyJson));
  } catch {
    hit = null;
  }
  if (firstImages.size > 500) firstImages.clear();
  firstImages.set(bodyJson, hit);
  return hit;
}
