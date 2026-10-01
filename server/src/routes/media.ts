import { Hono } from 'hono';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ulid } from 'ulidx';

// Archivos adjuntos a las notas: imágenes, vídeo y audio que se ven dentro, y
// cualquier otro (PDF, documentos, hojas de cálculo…) que se abre o se
// descarga. Se guardan como archivos junto a la base de datos (el mismo volumen
// /data en Docker) y la nota solo guarda su dirección, /api/media/<id>.<ext>.

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

// Lo que la nota muestra dentro: tipos que el navegador pinta sin ejecutar nada
// (sin SVG ni HTML).
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

// Se abren en el navegador, en su propio visor. Todo lo demás (también HTML,
// SVG o un .js) se sirve solo como descarga, así que nunca corre en esta web.
const VIEW: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };

const NAME = /^[0-9A-HJKMNP-TV-Z]{26}\.([a-z0-9]{1,10})$/;

// La extensión de un adjunto sale de su nombre original.
const extOf = (fileName: string) => /\.([a-z0-9]{1,10})$/.exec(fileName.toLowerCase())?.[1] ?? 'bin';

export function mediaRoutes(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = new Hono();

  // El cuerpo es el archivo tal cual; su tipo va en Content-Type y su nombre
  // (codificado como en una URL) en X-File-Name.
  r.post('/media', async (c) => {
    const mime = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    let fileName = '';
    try {
      fileName = decodeURIComponent(c.req.header('x-file-name') ?? '');
    } catch {
      // Un nombre mal codificado no impide guardar el archivo.
    }
    const ext = TYPES[mime] ?? extOf(fileName);
    if (Number(c.req.header('content-length') ?? 0) > MAX_MEDIA_BYTES) {
      return c.json({ error: 'El archivo pasa de 200 MB' }, 413);
    }
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'El archivo está vacío' }, 400);
    if (data.length > MAX_MEDIA_BYTES) return c.json({ error: 'El archivo pasa de 200 MB' }, 413);
    const name = `${ulid()}.${ext}`;
    await writeFile(join(dir, name), data, { flag: 'wx' });
    const kind = TYPES[mime] ? mime.split('/')[0] : 'file';
    return c.json({ url: `/api/media/${name}`, kind }, 201);
  });

  // Con soporte de Range para poder saltar dentro de un vídeo o un audio.
  r.get('/media/:name', (c) => {
    const name = c.req.param('name');
    const m = NAME.exec(name);
    if (!m) return c.json({ error: 'No encontrado' }, 404);
    const shown = MIME[m[1]] ?? VIEW[m[1]];
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return c.json({ error: 'No encontrado' }, 404);
    }
    const headers: Record<string, string> = {
      'content-type': shown ?? 'application/octet-stream',
      ...(shown ? {} : { 'content-disposition': 'attachment' }),
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
