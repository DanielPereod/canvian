// Enlaces de YouTube: qué vídeo es, y si un texto pide verlo incrustado.

import { splitAlt, splitSrc } from './image.js';

export function youtubeId(url: string): { id: string; start: number } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  // ?t=90, ?t=1m30s o ?start=90: empieza ahí.
  const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? '';
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
  const start = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  return { id, start };
}

// La sintaxis de incrustar de Markdown y Obsidian: ![texto](url), !<url> y
// ![[nota]] (o ![[url]]), sola en su línea.
export type EmbedRef = { url: string; alt: string } | { note: string };
const EMBED_MD = /^!\[([^\]\n]*)\]\(\s*<?([^\s<>()]+)>?(?:\s+"[^"]*")?\s*\)$/;
const EMBED_ANGLE = /^!<([^\s<>]+)>$/;
const EMBED_WIKI = /^!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]$/;
const isUrl = (s: string) => /^https?:\/\//i.test(s);
export function parseEmbed(text: string): EmbedRef | null {
  const s = text.trim();
  let m = EMBED_MD.exec(s);
  if (m) return { url: m[2], alt: m[1].trim() };
  m = EMBED_ANGLE.exec(s);
  if (m) return isUrl(m[1]) ? { url: m[1], alt: '' } : null;
  m = EMBED_WIKI.exec(s);
  if (m) return isUrl(m[1].trim()) ? { url: m[1].trim(), alt: '' } : { note: m[1].trim() };
  return null;
}

export const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;

// El bloque incrustado (en JSON) de lo que se enlaza: un vídeo de YouTube, una
// imagen, la ficha de una web o el contenido de otra nota.
export type EmbedJson = { type: string; attrs: Record<string, unknown> };
export function embedJson(ref: EmbedRef, id: string | null = null): EmbedJson | null {
  if ('note' in ref) return ref.note ? { type: 'noteEmbed', attrs: { id, target: ref.note } } : null;
  if (youtubeId(ref.url)) return { type: 'youtube', attrs: { src: ref.url } };
  const img = splitSrc(ref.url);
  if (IMAGE_URL.test(img.src) || img.src.startsWith('/api/media/')) {
    const { alt, width } = splitAlt(ref.alt);
    return { type: 'image', attrs: { src: img.src, alt: alt || null, ...(width ? { width } : {}), ...(img.crop ? { crop: img.crop } : {}) } };
  }
  if (isUrl(ref.url)) return { type: 'bookmark', attrs: { href: ref.url, title: ref.alt || null } };
  return null;
}

// Para lo que solo era de YouTube: la dirección, si la sintaxis incrusta un vídeo.
export function youtubeEmbed(text: string): string | null {
  const ref = parseEmbed(text);
  return ref && 'url' in ref && youtubeId(ref.url) ? ref.url : null;
}

// Lo que se escribe al exportar: Obsidian también lo enseña como el vídeo.
export const youtubeMarkdown = (src: string) => `![](${src})`;
