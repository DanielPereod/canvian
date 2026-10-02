import { Hono } from 'hono';
import type { Fetcher } from '../calendars.js';

// La ficha de un enlace web incrustado en una nota: su título, su descripción,
// su imagen y el nombre del sitio, leídos de la cabecera de la página (Open
// Graph, Twitter o <title>). Se recuerda un rato para no pedirla cada vez.

export type LinkCard = { url: string; title: string | null; description: string | null; image: string | null; site: string | null };

const TTL = 6 * 60 * 60_000;
const TIMEOUT = 8_000;
// Con la cabecera basta: no hace falta leer la página entera.
const MAX_BYTES = 512 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d: string, h: string, n: string) =>
      d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : (ENTITIES[n.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, ' ')
    .trim();

// Los atributos de una etiqueta <meta …> o <link …>.
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

export function parseCard(html: string, url: string): LinkCard {
  const meta = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, decode(a.content));
  }
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v) ?? null;
  const title = pick('og:title', 'twitter:title') ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)![1]) || null : null);
  const abs = (u: string | null) => {
    if (!u) return null;
    try {
      const r = new URL(u, url);
      return /^https?:$/.test(r.protocol) ? r.href : null;
    } catch {
      return null;
    }
  };
  let host: string | null = null;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Sin sitio.
  }
  return {
    url,
    title: title?.slice(0, 300) ?? null,
    description: pick('og:description', 'twitter:description', 'description')?.slice(0, 500) ?? null,
    image: abs(pick('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')),
    site: pick('og:site_name')?.slice(0, 100) ?? host,
  };
}

// Solo direcciones de fuera: nada de la red de casa ni del propio servidor.
function external(u: URL) {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!/^https?:$/.test(u.protocol)) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1' || /^f[cd]|^fe80/i.test(h)) return false;
  return true;
}

export function unfurlRoutes(fetcher: Fetcher = fetch) {
  const r = new Hono();
  const cache = new Map<string, { at: number; card: LinkCard }>();

  r.get('/unfurl', async (c) => {
    const raw = c.req.query('url') ?? '';
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return c.json({ error: 'Dirección no válida' }, 400);
    }
    if (raw.length > 2000 || !external(u)) return c.json({ error: 'Dirección no válida' }, 400);
    const hit = cache.get(u.href);
    if (hit && Date.now() - hit.at < TTL) return c.json(hit.card);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    let card: LinkCard;
    try {
      const res = await fetcher(u.href, { signal: ctrl.signal, headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; Canvian)' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/html|xml/i.test(type)) card = parseCard('', u.href);
      else {
        // Solo el principio de la página.
        const reader = res.body?.getReader();
        let html = '';
        const dec = new TextDecoder();
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          html += dec.decode(value, { stream: true });
          if (size > MAX_BYTES || /<\/head>/i.test(html)) break;
        }
        void reader?.cancel().catch(() => {});
        card = parseCard(html, res.url || u.href);
        card.url = u.href;
      }
    } catch {
      card = parseCard('', u.href);
    } finally {
      clearTimeout(timer);
    }
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    cache.set(u.href, { at: Date.now(), card });
    return c.json(card);
  });

  return r;
}
