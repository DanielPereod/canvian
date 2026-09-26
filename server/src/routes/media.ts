import { Hono } from 'hono';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ulid } from 'ulidx';

// Imágenes, vídeo y audio pegados en las notas. Se guardan como archivos junto
// a la base de datos (el mismo volumen /data en Docker) y la nota solo guarda
// su dirección, /api/media/<id>.<ext>.

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

// Solo tipos que el navegador muestra sin ejecutar nada: sin SVG ni HTML.
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};
const MIME: Record<string, string> = {};
for (const [mime, ext] of Object.entries(TYPES)) MIME[ext] ??= mime;

const NAME = /^[0-9A-HJKMNP-TV-Z]{26}\.([a-z0-9]{2,4})$/;

export function mediaRoutes(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = new Hono();

  // El cuerpo es el archivo tal cual; su tipo va en Content-Type.
  r.post('/media', async (c) => {
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[mime];
    if (!ext) return c.json({ error: 'Solo se pueden añadir imágenes, vídeo o audio' }, 415);
    if (Number(c.req.header('content-length') ?? 0) > MAX_MEDIA_BYTES) {
      return c.json({ error: 'El archivo pasa de 200 MB' }, 413);
    }
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'El archivo está vacío' }, 400);
    if (data.length > MAX_MEDIA_BYTES) return c.json({ error: 'El archivo pasa de 200 MB' }, 413);
    const name = `${ulid()}.${ext}`;
    await writeFile(join(dir, name), data, { flag: 'wx' });
    return c.json({ url: `/api/media/${name}`, kind: mime.split('/')[0] }, 201);
  });

  // Con soporte de Range para poder saltar dentro de un vídeo o un audio.
  r.get('/media/:name', (c) => {
    const name = c.req.param('name');
    const m = NAME.exec(name);
    const type = m && MIME[m[1]];
    if (!type) return c.json({ error: 'No encontrado' }, 404);
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return c.json({ error: 'No encontrado' }, 404);
    }
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      // El nombre es único y el archivo nunca cambia.
      'cache-control': 'private, max-age=31536000, immutable',
    };
    let start = 0;
    let end = size - 1;
    let status: 200 | 206 = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        return c.body(null, 416, { 'content-range': `bytes */${size}` });
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(end - start + 1);
    if (c.req.method === 'HEAD') return c.body(null, status, headers);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return c.body(stream, status, headers);
  });

  return r;
}
