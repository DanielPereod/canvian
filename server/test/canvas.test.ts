import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { toFtsQuery } from '../src/routes/canvas.js';

let app: ReturnType<typeof createApp>;
let cookie = '';
let personal: string;
let trabajo: string;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};
const data = async (method: string, path: string, body?: unknown) => (await call(method, path, body)).json();

beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  [{ id: personal }, { id: trabajo }] = await data('GET', '/api/profiles');
});

describe('notes', () => {
  it('creates, edits, moves and soft-deletes notes per profile', async () => {
    const note = await data('POST', `/api/profiles/${personal}/notes`, { x: 10, y: 20, title: 'Hola' });
    expect(note).toMatchObject({ kind: 'text', x: 10, y: 20, title: 'Hola', profileId: personal });

    const edited = await data('PATCH', `/api/notes/${note.id}`, { title: 'Hola mundo', bodyText: 'algo' });
    expect(edited.title).toBe('Hola mundo');

    expect((await call('PATCH', '/api/notes/layout', [{ id: note.id, x: 99, y: -5, w: 300 }])).status).toBe(204);
    const { notes } = await data('GET', `/api/profiles/${personal}/canvas`);
    expect(notes[0]).toMatchObject({ x: 99, y: -5, w: 300 });

    expect((await data('GET', `/api/profiles/${trabajo}/canvas`)).notes).toHaveLength(0);

    expect((await call('DELETE', `/api/notes/${note.id}`)).status).toBe(204);
    expect((await data('GET', `/api/profiles/${personal}/canvas`)).notes).toHaveLength(0);
    expect((await call('PATCH', `/api/notes/${note.id}`, { title: 'x' })).status).toBe(404);
  });

  it('accepts client-generated ids so the UI can create optimistically', async () => {
    const note = await data('POST', `/api/profiles/${personal}/notes`, { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', x: 0, y: 0 });
    expect(note.id).toBe('01JABCDEFGHJKMNPQRSTVWXYZ0');
  });

  it('detaches notes when their zone is deleted', async () => {
    const zone = await data('POST', `/api/profiles/${personal}/notes`, { kind: 'zone', x: 0, y: 0, w: 400, h: 300 });
    const inner = await data('POST', `/api/profiles/${personal}/notes`, { x: 20, y: 20, zoneId: zone.id });
    await call('DELETE', `/api/notes/${zone.id}`);
    const { notes } = await data('GET', `/api/profiles/${personal}/canvas`);
    expect(notes).toEqual([expect.objectContaining({ id: inner.id, zoneId: null })]);
  });
});

describe('edges', () => {
  it('links notes once, rejects self-links and cross-profile links, and drops links with the note', async () => {
    const a = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0 });
    const b = await data('POST', `/api/profiles/${personal}/notes`, { x: 200, y: 0 });
    const other = await data('POST', `/api/profiles/${trabajo}/notes`, { x: 0, y: 0 });

    const edge = await data('POST', `/api/profiles/${personal}/edges`, { fromId: a.id, toId: b.id });
    const again = await data('POST', `/api/profiles/${personal}/edges`, { fromId: b.id, toId: a.id });
    expect(again.id).toBe(edge.id);
    expect((await call('POST', `/api/profiles/${personal}/edges`, { fromId: a.id, toId: a.id })).status).toBe(400);
    expect((await call('POST', `/api/profiles/${personal}/edges`, { fromId: a.id, toId: other.id })).status).toBe(404);

    expect((await data('PATCH', `/api/edges/${edge.id}`, { label: 'depende de' })).label).toBe('depende de');

    await call('DELETE', `/api/notes/${b.id}`);
    expect((await data('GET', `/api/profiles/${personal}/canvas`)).edges).toHaveLength(0);
  });
});

describe('search', () => {
  it('finds notes by prefix, ignoring accents, within the profile only', async () => {
    await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, title: 'Presupuesto viaje', bodyText: 'Lisboa en octubre' });
    await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, title: 'Reunión', bodyText: 'Revisar camión' });
    await data('POST', `/api/profiles/${trabajo}/notes`, { x: 0, y: 0, title: 'Presupuesto Q4' });

    const hits = await data('GET', `/api/profiles/${personal}/search?q=presu`);
    expect(hits.map((h: { title: string }) => h.title)).toEqual(['Presupuesto viaje']);
    expect((await data('GET', `/api/profiles/${personal}/search?q=camion`))[0].title).toBe('Reunión');
    expect((await data('GET', `/api/profiles/${personal}/search?q=lisb octu`))).toHaveLength(1);
    expect(await data('GET', `/api/profiles/${personal}/search?q=${encodeURIComponent('"a" OR')}`)).toEqual([]);
    expect(await data('GET', `/api/profiles/${personal}/search?q=`)).toHaveLength(2);
  });

  it('builds safe FTS queries', () => {
    expect(toFtsQuery('  hola  "mundo" ')).toBe('"hola"* "mundo"*');
    expect(toFtsQuery('   ')).toBeNull();
  });
});
