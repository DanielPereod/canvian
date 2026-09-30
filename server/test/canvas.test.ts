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

  it('no longer has task notes: tasks are checkboxes inside a note', async () => {
    const note = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, title: 'Comprar pan' });
    expect((await call('PATCH', `/api/notes/${note.id}`, { kind: 'task' })).status).toBe(400);
    expect((await call('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, kind: 'quick', title: 'Pan' })).status).toBe(400);
  });

  it('accepts client-generated ids so the UI can create optimistically', async () => {
    const note = await data('POST', `/api/profiles/${personal}/notes`, { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', x: 0, y: 0 });
    expect(note.id).toBe('01JABCDEFGHJKMNPQRSTVWXYZ0');
  });

  it('archives and unarchives a note without losing it', async () => {
    const note = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, title: 'Vieja' });
    expect(note.archivedAt).toBeNull();
    const at = '2026-09-27T10:00:00.000Z';
    expect(await data('PATCH', `/api/notes/${note.id}`, { archivedAt: at })).toMatchObject({ archivedAt: at });
    const { notes } = await data('GET', `/api/profiles/${personal}/canvas`);
    expect(notes[0]).toMatchObject({ id: note.id, archivedAt: at });
    expect(await data('PATCH', `/api/notes/${note.id}`, { archivedAt: null })).toMatchObject({ archivedAt: null });
  });

  it('moves the children of a deleted note to its parent', async () => {
    const outer = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0 });
    const zone = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, zoneId: outer.id });
    const inner = await data('POST', `/api/profiles/${personal}/notes`, { x: 20, y: 20, zoneId: zone.id });
    await call('DELETE', `/api/notes/${zone.id}`);
    const { notes } = await data('GET', `/api/profiles/${personal}/canvas`);
    expect(notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: inner.id, zoneId: outer.id }), expect.objectContaining({ id: outer.id, zoneId: null })]),
    );
    expect(notes).toHaveLength(2);
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

describe('properties', () => {
  it('defines custom properties per profile and stores their values on notes', async () => {
    const zona = await data('POST', `/api/profiles/${personal}/properties`, { name: 'Contexto', type: 'select', options: ['casa', 'calle'] });
    expect(zona).toMatchObject({ name: 'Contexto', type: 'select', options: ['casa', 'calle'], position: 0 });
    const horas = await data('POST', `/api/profiles/${personal}/properties`, { name: 'Horas', type: 'number' });
    expect(horas.position).toBe(1);
    expect((await call('POST', `/api/profiles/${personal}/properties`, { name: 'contexto', type: 'text' })).status).toBe(409);
    expect((await call('POST', `/api/profiles/${personal}/properties`, { name: 'Raro', type: 'color' })).status).toBe(400);
    expect(await data('GET', `/api/profiles/${trabajo}/properties`)).toHaveLength(0);

    const renamed = await data('PATCH', `/api/properties/${zona.id}`, { name: 'Lugar', options: ['casa', 'calle', 'oficina'] });
    expect(renamed).toMatchObject({ name: 'Lugar', options: ['casa', 'calle', 'oficina'] });

    const note = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, props: { [zona.id]: 'casa', [horas.id]: 2 } });
    expect(JSON.parse(note.props)).toEqual({ [zona.id]: 'casa', [horas.id]: 2 });
    const dated = await data('PATCH', `/api/notes/${note.id}`, { priority: 3, dueAt: '2026-10-03' });
    expect(dated).toMatchObject({ priority: 3, dueAt: '2026-10-03' });
    expect((await call('PATCH', `/api/notes/${note.id}`, { props: { x: { nested: true } } })).status).toBe(400);

    expect((await call('DELETE', `/api/properties/${zona.id}`)).status).toBe(204);
    const { notes } = await data('GET', `/api/profiles/${personal}/canvas`);
    expect(JSON.parse(notes[0].props)).toEqual({ [horas.id]: 2 });
    expect(await data('GET', `/api/profiles/${personal}/properties`)).toHaveLength(1);
  });
});

describe('lenses', () => {
  it('stores tags as a list of words', async () => {
    const def = await data('POST', `/api/profiles/${personal}/properties`, { name: 'Etiquetas', type: 'tags' });
    expect(def).toMatchObject({ type: 'tags', options: [] });
    const note = await data('POST', `/api/profiles/${personal}/notes`, { x: 0, y: 0, props: { [def.id]: ['test_tag', 'casa'] } });
    expect(JSON.parse(note.props)).toEqual({ [def.id]: ['test_tag', 'casa'] });
    expect((await call('PATCH', `/api/notes/${note.id}`, { props: { [def.id]: [''] } })).status).toBe(400);
  });

  it('saves lenses with free shortcut slots and moves a slot when reassigned', async () => {
    const a = await data('POST', `/api/profiles/${personal}/lenses`, { name: 'Abiertas', query: 'tipo:tarea -hecha' });
    expect(a).toMatchObject({ name: 'Abiertas', mode: 'dim', slot: 1 });
    const b = await data('POST', `/api/profiles/${personal}/lenses`, { name: 'Kanban', query: 'tipo:tarea', mode: 'arrange:status' });
    expect(b.slot).toBe(2);
    expect((await call('POST', `/api/profiles/${personal}/lenses`, { name: 'x', query: 'y', mode: 'rara' })).status).toBe(400);

    await call('PATCH', `/api/lenses/${b.id}`, { slot: 1 });
    const list = await data('GET', `/api/profiles/${personal}/lenses`);
    expect(list.find((l: { id: string }) => l.id === a.id).slot).toBeNull();
    expect(list.find((l: { id: string }) => l.id === b.id).slot).toBe(1);
    expect(await data('GET', `/api/profiles/${trabajo}/lenses`)).toHaveLength(0);

    expect((await call('DELETE', `/api/lenses/${a.id}`)).status).toBe(204);
    expect(await data('GET', `/api/profiles/${personal}/lenses`)).toHaveLength(1);
  });

  it('no longer accepts zones', async () => {
    const res = await call('POST', `/api/profiles/${personal}/notes`, { kind: 'zone', x: 0, y: 0 });
    expect(res.status).toBe(400);
  });
});
