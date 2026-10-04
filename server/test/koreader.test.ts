import { describe, expect, it, beforeEach } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let cookie = '';

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

let token = '';
const plugin = (method: string, path: string, body?: unknown, key = token) =>
  app.request(`/koreader${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Los archivos de un .zip (solo lo que genera Canvian: deflate, sin extras).
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString();
    const data = buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    out[name] = inflateRawSync(data).toString();
    at += 30 + nameLen + size;
  }
  return out;
}

const book = { key: 'abc123', title: 'Meditaciones', authors: 'Marco Aurelio' };
const highlights = [
  { text: 'Lo que no es bueno para la colmena no es bueno para la abeja.', chapter: 'Libro VI', page: 54, datetime: '2026-10-01 21:00:00' },
  { text: 'Pierde poco quien pierde el presente.', note: 'Releer', chapter: 'Libro VI', pageno: 60 },
];

let profileId = '';
beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  token = (await (await call('POST', '/api/koreader/token')).json()).token;
  profileId = (await (await call('GET', '/api/profiles')).json())[0].id;
});

const notesOf = async () => (await (await call('GET', `/api/profiles/${profileId}/canvas`)).json()).notes as { id: string; title: string; zoneId: string | null; bodyText: string; props: string }[];

describe('koreader', () => {
  it('needs its key', async () => {
    expect((await plugin('GET', '/profiles', undefined, 'otra')).status).toBe(401);
    const profiles = await (await plugin('GET', '/profiles')).json();
    expect(profiles.profiles.map((p: { name: string }) => p.name)).toEqual(['Personal', 'Trabajo']);
    await call('DELETE', '/api/koreader/token');
    expect((await plugin('GET', '/profiles')).status).toBe(401);
  });

  it('keeps one note per book, updated on every sync', async () => {
    const first = await (await plugin('POST', '/sync', { profile: profileId, book, annotations: highlights })).json();
    expect(first).toMatchObject({ created: true, changed: true, count: 2, title: 'Meditaciones' });

    let notes = await notesOf();
    const folder = notes.find((n) => n.title === 'KOReader')!;
    const note = notes.find((n) => n.id === first.id)!;
    expect(note.zoneId).toBe(folder.id);
    expect(note.bodyText).toContain('Subrayados');
    expect(note.bodyText).toContain('Libro VI');
    expect(note.bodyText).toContain('Pierde poco quien pierde el presente.');
    expect(note.bodyText).toContain('Releer');
    expect(note.bodyText).toContain('p. 54 · 2026-10-01');
    expect(Object.values(JSON.parse(note.props))).toContain('Marco Aurelio');

    // Lo mismo otra vez: nada cambia.
    const again = await (await plugin('POST', '/sync', { profile: profileId, book, annotations: highlights })).json();
    expect(again).toMatchObject({ id: first.id, created: false, changed: false });

    // Lo escrito encima de «Subrayados» se queda; los subrayados se rehacen.
    const doc = JSON.parse((await (await call('GET', `/api/profiles/${profileId}/canvas`)).json()).notes.find((n: { id: string }) => n.id === first.id).bodyJson);
    doc.content.splice(1, 0, { type: 'paragraph', content: [{ type: 'text', text: 'Mis ideas sobre el libro' }] });
    await call('PATCH', `/api/notes/${first.id}`, { bodyJson: JSON.stringify(doc), bodyText: 'x' });
    const third = await (await plugin('POST', '/sync', { profile: profileId, book, annotations: [highlights[1]] })).json();
    expect(third).toMatchObject({ id: first.id, changed: true, count: 1 });
    notes = await notesOf();
    const updated = notes.find((n) => n.id === first.id)!;
    expect(updated.bodyText).toContain('Mis ideas sobre el libro');
    expect(updated.bodyText).not.toContain('colmena');
    expect(notes.filter((n) => n.title === 'Meditaciones')).toHaveLength(1);
    expect(notes.filter((n) => n.title === 'KOReader')).toHaveLength(1);
  });

  it('uses the chosen folder and skips books without highlights', async () => {
    const folder = await (await call('POST', `/api/profiles/${profileId}/notes`, { id: '01FOLDERLIBROS0000000000000', kind: 'text', title: 'Libros', bodyText: 'Libros', x: 0, y: 0 })).json();
    expect((await call('PUT', '/api/koreader/folder', { profileId, noteId: 'nope' })).status).toBe(404);
    const status = await (await call('PUT', '/api/koreader/folder', { profileId, noteId: folder.id })).json();
    expect(status.folders[profileId]).toBe(folder.id);

    expect(await (await plugin('POST', '/sync', { book: { key: 'vacío' }, annotations: {} })).json()).toEqual({ skipped: true });
    const res = await (await plugin('POST', '/sync', { book, annotations: highlights })).json();
    expect((await notesOf()).find((n) => n.id === res.id)!.zoneId).toBe(folder.id);
  });

  it('downloads the plugin already set up', async () => {
    await call('DELETE', '/api/koreader/token');
    const res = await call('GET', `/api/koreader/plugin.zip?profile=${profileId}&base=${encodeURIComponent('https://notas.example.org/')}&lang=en`);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['canvian.koplugin/_meta.lua', 'canvian.koplugin/canvian_config.lua', 'canvian.koplugin/main.lua']);
    const fresh = (await (await call('GET', '/api/koreader')).json()).token;
    expect(fresh).toBeTruthy();
    const config = files['canvian.koplugin/canvian_config.lua'];
    expect(config).toContain('url = "https://notas.example.org"');
    expect(config).toContain(`token = "${fresh}"`);
    expect(config).toContain(`profile = "${profileId}"`);
    expect(config).toContain('profile_name = "Personal"');
    expect(config).toContain('lang = "en"');
  });
});
