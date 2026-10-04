// Imágenes de las notas con tamaño y recorte. El archivo no se toca: la nota
// guarda el ancho (en píxeles) y el trozo que se ve, como fracciones de la
// imagen entera. En Markdown sale como en Obsidian, ![texto|300](enlace), y el
// recorte va detrás del enlace (#crop=x,y,ancho,alto,proporción), que el
// navegador y Obsidian pasan por alto: allí se ve la imagen entera a ese ancho.

export type Crop = { x: number; y: number; w: number; h: number; ratio: number | null };

const round = (n: number) => Math.round(n * 10000) / 10000;
const frac = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

export function parseCrop(raw: unknown): Crop | null {
  if (typeof raw !== 'string' || !raw) return null;
  const [x, y, w, h, r] = raw.split(',').map(Number);
  if (![x, y, w, h].every(frac) || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h, ratio: Number.isFinite(r) && r > 0 ? r : null };
}

export const formatCrop = ({ x, y, w, h, ratio }: Crop) => [x, y, w, h, ...(ratio ? [ratio] : [])].map(round).join(',');

// Casi la imagen entera: sin recorte.
export const isWhole = (c: Crop) => c.w > 0.995 && c.h > 0.995;

const CROP = /#crop=([\d.,]+)$/;

// El enlace sin el recorte, y el recorte que llevaba.
export function splitSrc(url: string): { src: string; crop: string | null } {
  const m = CROP.exec(url);
  const crop = m && parseCrop(m[1]);
  return m ? { src: url.slice(0, m.index), crop: crop ? formatCrop(crop) : null } : { src: url, crop: null };
}

// «texto|300» (o «texto|300x200», del que vale el ancho): el texto y el ancho.
export function splitAlt(alt: string): { alt: string; width: number | null } {
  const m = /^(.*?)\|\s*(\d{1,5})(?:x\d{1,5})?\s*$/.exec(alt);
  return m ? { alt: m[1].trim(), width: Number(m[2]) || null } : { alt: alt.trim(), width: null };
}

export function imageMarkdown(attrs: Record<string, unknown> | undefined): string {
  const alt = String(attrs?.alt ?? '').replace(/[[\]|]/g, '');
  const width = Number(attrs?.width) > 0 ? Math.round(Number(attrs!.width)) : null;
  const crop = parseCrop(attrs?.crop);
  const src = String(attrs?.src ?? '') + (crop && !isWhole(crop) ? `#crop=${formatCrop(crop)}` : '');
  return `![${alt}${width ? `|${width}` : ''}](${src})`;
}
