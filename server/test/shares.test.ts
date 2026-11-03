import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let cookie = '';
let profileId = '';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = { cookie }) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const anon = (method: string, path: string, body?: unknown, visitor = '') => call(method, path, body, visitor ? { cookie: visitor } : {});

const doc = (text: string, extra: unknown[] = []) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...extra] });

const note = async (id: string, title: string, zoneId: string | null = null, bodyJson = doc(title)) => {
  const res = await call('POST', `/api/profiles/${profileId}/notes`, { id, title, x: 0, y: 0, zoneId, bodyJson, bodyText: title });
  expect(res.status).toBe(201);
};

beforeEach(async () => {
  app = createApp(openDb(':memory:'), { mediaDir: mkdtempSync(join(tmpdir(), 'canvian-share-')) });
  const res = await call('POST', '/api/auth/setup', { password: 'una-clave-larga' }, {});
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  profileId = (await (await call('GET', '/api/profiles')).json())[0].id;
  // Casa > (Cocina > Nevera), Baño
  await note('01CASA000000000000000000000', 'Casa');
  await note('01COCINA0000000000000000000', 'Cocina', '01CASA000000000000000000000');
  await note('01NEVERA0000000000000000000', 'Nevera', '01COCINA0000000000000000000');
  await note('01BANO00000000000000000000', 'Baño', '01CASA000000000000000000000');
  await note('01OTRA00000000000000000000', 'Otra');
});

const share = async (noteId: string, body: unknown) => {
  const res = await call('PUT', `/api/notes/${noteId}/share`, body);
  return { status: res.status, data: await res.json() };
};
const titles = (data: { notes: { title: string }[] }) => data.notes.map((n) => n.title).sort();

describe('notas públicas', () => {
  it('no deja compartir sin sesión y no hay enlace hasta crearlo', async () => {
    expect((await anon('PUT', '/api/notes/01CASA000000000000000000000/share', { scope: 'note' })).status).toBe(401);
    expect(await (await call('GET', '/api/notes/01CASA000000000000000000000/share')).json()).toBeNull();
    expect((await anon('GET', '/api/public/nada')).status).toBe(404);
  });

  it('comparte solo la madre, todas las hijas o las elegidas', async () => {
    const { status, data } = await share('01CASA000000000000000000000', { scope: 'note' });
    expect(status).toBe(201);
    expect(data).toMatchObject({ scope: 'note', hasPassword: false });
    const slug = data.id as string;
    expect(slug.length).toBeGreaterThanOrEqual(16);

    const only = await (await anon('GET', `/api/public/${slug}`)).json();
    expect(titles(only)).toEqual(['Casa']);
    expect(only.rootId).toBe('01CASA000000000000000000000');

    // El mismo enlace al cambiar a todas: también las nietas.
    const all = await share('01CASA000000000000000000000', { scope: 'all' });
    expect(all.status).toBe(200);
    expect(all.data.id).toBe(slug);
    const full = await (await anon('GET', `/api/public/${slug}`)).json();
    expect(titles(full)).toEqual(['Baño', 'Casa', 'Cocina', 'Nevera']);
    expect(full.notes.find((n: { title: string }) => n.title === 'Nevera').parentId).toBe('01COCINA0000000000000000000');

    // Elegidas: una nieta sin su madre no entra.
    await share('01CASA000000000000000000000', { scope: 'some', childIds: ['01BANO00000000000000000000', '01NEVERA0000000000000000000'] });
    expect(titles(await (await anon('GET', `/api/public/${slug}`)).json())).toEqual(['Baño', 'Casa']);
    await share('01CASA000000000000000000000', { scope: 'some', childIds: ['01COCINA0000000000000000000', '01NEVERA0000000000000000000'] });
    expect(titles(await (await anon('GET', `/api/public/${slug}`)).json())).toEqual(['Casa', 'Cocina', 'Nevera']);

    // Una nota de fuera nunca se ve, aunque se cuele en la lista.
    await share('01CASA000000000000000000000', { scope: 'some', childIds: ['01OTRA00000000000000000000'] });
    expect(titles(await (await anon('GET', `/api/public/${slug}`)).json())).toEqual(['Casa']);

    const listed = await (await call('GET', `/api/profiles/${profileId}/shares`)).json();
    expect(listed).toHaveLength(1);
  });

  it('pide la contraseña y la recuerda con una cookie', async () => {
    const short = await share('01CASA000000000000000000000', { scope: 'note', password: 'abc' });
    expect(short.status).toBe(400);
    const { data } = await share('01CASA000000000000000000000', { scope: 'note', password: 'secreta' });
    expect(data.hasPassword).toBe(true);
    const slug = data.id;

    const locked = await anon('GET', `/api/public/${slug}`);
    expect(locked.status).toBe(401);
    expect(await locked.json()).toMatchObject({ locked: true });
    expect(JSON.stringify(await (await anon('GET', `/api/public/${slug}`)).json())).not.toContain('Casa');

    expect((await anon('POST', `/api/public/${slug}/unlock`, { password: 'mala' })).status).toBe(401);
    const ok = await anon('POST', `/api/public/${slug}/unlock`, { password: 'secreta' });
    expect(ok.status).toBe(200);
    const visitor = ok.headers.get('set-cookie')!.split(';')[0];
    expect(ok.headers.get('set-cookie')).toContain(`Path=/api/public/${slug}`);
    expect((await anon('GET', `/api/public/${slug}`, undefined, visitor)).status).toBe(200);

    // Cambiar otra cosa no la pide de nuevo; cambiar la contraseña sí.
    await share('01CASA000000000000000000000', { scope: 'all' });
    expect((await anon('GET', `/api/public/${slug}`, undefined, visitor)).status).toBe(200);
    await share('01CASA000000000000000000000', { scope: 'all', password: 'otra-secreta' });
    expect((await anon('GET', `/api/public/${slug}`, undefined, visitor)).status).toBe(401);

    // Quitarla la deja abierta.
    await share('01CASA000000000000000000000', { scope: 'all', password: null });
    expect((await anon('GET', `/api/public/${slug}`)).status).toBe(200);
  });

  it('frena a quien prueba contraseñas sin parar', async () => {
    const { data } = await share('01CASA000000000000000000000', { scope: 'note', password: 'secreta' });
    for (let i = 0; i < 10; i++) expect((await anon('POST', `/api/public/${data.id}/unlock`, { password: `mala${i}` })).status).toBe(401);
    expect((await anon('POST', `/api/public/${data.id}/unlock`, { password: 'secreta' })).status).toBe(429);
  });

  it('deja de verse al quitar el enlace, archivar o borrar la nota', async () => {
    const { data } = await share('01CASA000000000000000000000', { scope: 'all' });
    await call('PATCH', '/api/notes/01CASA000000000000000000000', { archivedAt: new Date().toISOString() });
    expect((await anon('GET', `/api/public/${data.id}`)).status).toBe(404);
    await call('PATCH', '/api/notes/01CASA000000000000000000000', { archivedAt: null });
    expect((await anon('GET', `/api/public/${data.id}`)).status).toBe(200);
    expect((await call('DELETE', '/api/notes/01CASA000000000000000000000/share')).status).toBe(204);
    expect((await anon('GET', `/api/public/${data.id}`)).status).toBe(404);

    const again = await share('01CASA000000000000000000000', { scope: 'note' });
    expect(again.data.id).not.toBe(data.id);
    await call('DELETE', '/api/notes/01CASA000000000000000000000');
    expect((await anon('GET', `/api/public/${again.data.id}`)).status).toBe(404);
  });

  it('sirve las imágenes de lo compartido y ninguna otra', async () => {
    const up = async () =>
      (await (await app.request('/api/media', { method: 'POST', headers: { 'content-type': 'image/png', cookie }, body: new Uint8Array(png) })).json()).url as string;
    const inside = await up();
    const outside = await up();
    await note('01FOTO00000000000000000000', 'Foto', null, doc('Foto', [{ type: 'image', attrs: { src: inside } }]));
    const { data } = await share('01FOTO00000000000000000000', { scope: 'note' });
    const got = await (await anon('GET', `/api/public/${data.id}`)).json();
    const name = inside.split('/').pop()!;
    expect(got.notes[0].bodyJson).toContain(`/api/public/${data.id}/media/${name}`);
    expect(got.notes[0].bodyJson).not.toContain(`"${inside}"`);

    const ok = await anon('GET', `/api/public/${data.id}/media/${name}`);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(png);
    expect((await anon('GET', `/api/public/${data.id}/media/${outside.split('/').pop()}`)).status).toBe(404);
    expect((await anon('GET', inside)).status).toBe(401);
  });
});
