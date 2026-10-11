import type { Fetcher } from '../calendars.js';
import { external } from '../routes/unfurl.js';
import { McpError } from './notes.js';

// Imágenes que sube Claude por el MCP (una portada de libro, una foto…): llegan
// en base64 o como dirección de la web y se guardan como las demás, en /api/media.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT = 15_000;
const MAX_REDIRECTS = 5;

/** El tipo de verdad, por los primeros bytes (no por lo que diga quien la manda). */
export function sniffImage(data: Buffer): string | null {
  const hex = data.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(data.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

const tooBig = () => new McpError(`La imagen pasa de ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);

/** «iVBOR…» o «data:image/png;base64,iVBOR…». */
export function fromBase64(raw: string): Buffer {
  const b64 = raw.trim().replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new McpError('El base64 de la imagen no es válido.');
  if (b64.length * 0.75 > MAX_IMAGE_BYTES + 3) throw tooBig();
  return Buffer.from(b64, 'base64');
}

/** La descarga, siguiendo redirecciones solo hacia fuera (nada de la red de casa). */
export async function fromUrl(raw: string, fetcher: Fetcher = fetch): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new McpError('La dirección de la imagen no es válida.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    for (let hop = 0; ; hop++) {
      if (!external(u)) throw new McpError('Solo se pueden traer imágenes de direcciones http(s) públicas.');
      const res = await fetcher(u.href, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; Canvian)' } });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (next) {
        if (hop >= MAX_REDIRECTS) throw new McpError('La dirección redirige demasiadas veces.');
        u = new URL(next, u);
        continue;
      }
      if (!res.ok) throw new McpError(`No se pudo descargar la imagen (HTTP ${res.status}).`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw tooBig();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          void reader.cancel().catch(() => {});
          throw tooBig();
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError('No se pudo descargar la imagen.');
  } finally {
    clearTimeout(timer);
  }
}
