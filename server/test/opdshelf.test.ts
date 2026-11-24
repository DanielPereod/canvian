import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { docToMarkdown } from '../src/doc/markdown.js';
import { parseBody } from '../src/doc/json.js';
import type { Fetcher } from '../src/opdshelf/sync.js';

let app: ReturnType<typeof createApp>;
let cookie = '';
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};

// Un opdshelf de mentira: la lista de libros, los subrayados de cada uno, los autores y la portada.
const DOC = 'abc123';
let updated = 100;
let annotations: Record<string, unknown>[] = [];
let asked: { url: string; auth: string | undefined }[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c70000000049454e44ae426082', 'hex');
const fake: Fetcher = async (url, init) => {
  asked.push({ url, auth: init.headers.authorization });
  if (init.headers.authorization !== `Basic ${Buffer.from('dani:secreto').toString('base64')}` && init.headers.authorization !== 'Bearer opds_llave') {
    return new Response('Unauthorized', { status: 401 });
  }
  const path = new URL(url).pathname;
  if (path === '/api/annotations') return Response.json({ books: [{ document: DOC, highlights: annotations.length, notes: 1, updated, path: 'Estoicos/Meditaciones.epub', title: 'Meditaciones' }], server_time: 1 });
  if (path === `/api/annotations/${DOC}`) return Response.json({ document: DOC, annotations, server_time: 1 });
  if (path === '/api/highlights') return Response.json({ highlights: [{ document: DOC, authors: 'Marco Aurelio' }] });
  if (path === '/cover/Estoicos/Meditaciones.epub') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  return new Response('not found', { status: 404 });
};

let profileId = '';
beforeEach(async () => {
  app = createApp(openDb(':memory:'), { fetchOpdshelf: fake, mediaDir: mkdtempSync(join(tmpdir(), 'canvian-opds-')) });
  cookie = '';
  updated = 100;
  asked = [];
  annotations = [
    { id: 'kor_1', text: 'Lo que no es bueno para la colmena no es bueno para la abeja.', color: 'yellow', chapter: 'Libro VI', page: 54, created: 1790000000, updated: 100 },
    { id: 'web-2', text: 'Pierde poco quien pierde el presente.', note: 'Releer', color: 'blue', chapter: 'Libro VI', created: 1790000100, updated: 90 },
    { id: 'gone', deleted: true, updated: 80 },
  ];
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  profileId = (await (await call('GET', '/api/profiles')).json())[0].id;
});

const bookNotes = async () => {
  const { notes } = await (await call('GET', `/api/profiles/${profileId}/canvas`)).json();
  return (notes as { id: string; title: string; props: string; bodyJson: string; zoneId: string | null }[]).filter((n) => n.props && JSON.parse(n.props).koreader);
};
const markdownOf = (n: { bodyJson: string }) => docToMarkdown(parseBody(n.bodyJson)!);

describe('opdshelf', () => {
  it('needs a session and a valid address, and never shows the password', async () => {
    const saved = cookie;
    cookie = '';
    expect((await call('GET', '/api/opdshelf')).status).toBe(401);
    cookie = saved;
    expect((await call('PUT', '/api/opdshelf', { url: 'no es una url' })).status).toBe(400);
    const res = await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org/', username: 'dani', password: 'secreto' });
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.config).toEqual({ url: 'https://opd.example.org', username: 'dani', profileId: null, hasKey: false, hasPassword: true });
    expect(JSON.stringify(status)).not.toContain('secreto');
    // Volver a guardar sin contraseña la conserva.
    await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org', username: 'dani' });
    expect((await (await call('GET', '/api/opdshelf')).json()).config.hasPassword).toBe(true);
    await call('DELETE', '/api/opdshelf');
    expect((await (await call('GET', '/api/opdshelf')).json()).config).toBeNull();
  });

  it('makes one note per book with stable block ids, colour, author, cover and a link to the reader', async () => {
    await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org', username: 'dani', password: 'secreto' });
    const res = await call('POST', '/api/opdshelf/sync');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ books: 1, created: 1, updated: 0 });

    const [book] = await bookNotes();
    expect(book.title).toBe('Meditaciones');
    const props = JSON.parse(book.props);
    expect(props.koreader).toBe(DOC);
    expect(props.opdshelf).toBe(true);
    expect(Object.values(props)).toContain('Marco Aurelio');
    expect(props.koreaderCover).toMatch(/^\/api\/media\//);

    const md = markdownOf(book);
    expect(md).toContain('## Subrayados');
    expect(md).toContain('### Libro VI');
    expect(md).toContain('> Lo que no es bueno para la colmena no es bueno para la abeja.\n^op-kor-1');
    expect(md).toContain('^op-web-2');
    expect(md).toContain('Releer');
    expect(md).toContain('🟡 · p. 54');
    expect(md).toContain('https://opd.example.org/read/Estoicos/Meditaciones.epub#note=kor_1');
    expect(md).not.toContain('gone');
  });

  it('only fetches books that changed, and keeps what is written above «Subrayados»', async () => {
    await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org', key: 'opds_llave' });
    await call('POST', '/api/opdshelf/sync');
    expect(asked.every((a) => a.auth === 'Bearer opds_llave')).toBe(true);
    const [book] = await bookNotes();
    // Lo que escribe Dani encima de los subrayados.
    const doc = parseBody(book.bodyJson)!;
    const content = [...doc.content!];
    content.splice(1, 0, { type: 'paragraph', content: [{ type: 'text', text: 'Mi resumen' }] });
    await call('PATCH', `/api/notes/${book.id}`, { bodyJson: JSON.stringify({ ...doc, content }) });

    asked = [];
    expect(await (await call('POST', '/api/opdshelf/sync')).json()).toMatchObject({ created: 0, updated: 0 });
    expect(asked.map((a) => new URL(a.url).pathname)).toEqual(['/api/annotations']);

    updated = 200;
    annotations = [annotations[1]];
    expect(await (await call('POST', '/api/opdshelf/sync')).json()).toMatchObject({ created: 0, updated: 1 });
    const [again] = await bookNotes();
    expect(again.id).toBe(book.id);
    const md = markdownOf(again);
    expect(md).toContain('Mi resumen');
    expect(md).not.toContain('colmena');
    expect(md).toContain('^op-web-2');
  });

  it('reports a wrong password', async () => {
    await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org', username: 'dani', password: 'mal' });
    const res = await call('POST', '/api/opdshelf/sync');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/no acepta/);
    expect(body.status.lastError).toMatch(/no acepta/);
  });

  it('the KOReader plugin does not overwrite a book that comes from opdshelf', async () => {
    await call('PUT', '/api/opdshelf', { url: 'https://opd.example.org', username: 'dani', password: 'secreto' });
    await call('POST', '/api/opdshelf/sync');
    const token = (await (await call('POST', '/api/koreader/token')).json()).token;
    const res = await app.request('/koreader/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ book: { key: DOC, title: 'Meditaciones' }, annotations: [{ text: 'Otra cosa' }] }),
    });
    expect(await res.json()).toMatchObject({ changed: false });
    const [book] = await bookNotes();
    expect(markdownOf(book)).toContain('^op-kor-1');
    expect(markdownOf(book)).not.toContain('Otra cosa');
  });
});
