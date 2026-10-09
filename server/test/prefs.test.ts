import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let cookie = '';

const call = async (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  const res = await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

describe('prefs', () => {
  it('saves and returns the keymap, and never leaks other settings', async () => {
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({});
    expect((await call('PUT', '/api/prefs/keymap', { newNote: 'q', tasks: 'mod+j' })).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ keymap: { newNote: 'q', tasks: 'mod+j' } });
    expect(JSON.stringify(await (await call('GET', '/api/prefs')).json())).not.toContain('argon');
    expect((await call('DELETE', '/api/prefs/keymap')).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({});
  });

  it('saves the appearance: mode and a theme per tone', async () => {
    const look = { mode: 'auto', dark: 'minimo', light: 'minimo-claro' };
    expect((await call('PUT', '/api/prefs/appearance', look)).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ appearance: look });
    expect((await call('PUT', '/api/prefs/appearance', { ...look, mode: 'noche' })).status).toBe(400);
    expect((await call('DELETE', '/api/prefs/appearance')).status).toBe(204);
  });

  it('saves an appearance per profile', async () => {
    const mine = { p1: { mode: 'dark', dark: 'observatorio', light: 'papel' } };
    expect((await call('PUT', '/api/prefs/profileThemes', mine)).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ profileThemes: mine });
    expect((await call('PUT', '/api/prefs/profileThemes', { p1: { mode: 'dark', dark: 'nada', light: 'papel' } })).status).toBe(400);
  });

  it('saves the type: a font per role and the size', async () => {
    const type = { ui: 'geist', titles: 'tema', text: 'literata', code: 'fira-code', size: 15 };
    expect((await call('PUT', '/api/prefs/type', type)).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ type });
    expect((await call('PUT', '/api/prefs/type', { ...type, code: undefined })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/type', { ...type, ui: "'Comic Sans'" })).status).toBe(400);
  });

  it('saves the notes shown in wide mode', async () => {
    expect((await call('PUT', '/api/prefs/wide', ['01HZX', '01HZY'])).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ wide: ['01HZX', '01HZY'] });
    expect((await call('PUT', '/api/prefs/wide', { '01HZX': true })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/wide', [''])).status).toBe(400);
  });

  it('saves the notes shown as a collection', async () => {
    expect((await call('PUT', '/api/prefs/collection', ['01HZX'])).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ collection: ['01HZX'] });
    expect((await call('PUT', '/api/prefs/collection', 'x')).status).toBe(400);
  });

  it('saves the language', async () => {
    expect((await call('PUT', '/api/prefs/lang', 'en')).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ lang: 'en' });
    expect((await call('PUT', '/api/prefs/lang', 'fr')).status).toBe(400);
  });

  it('saves the views of each collection', async () => {
    const view = {
      id: 'v1',
      name: 'Pendientes',
      type: 'board',
      filters: [{ id: 'f1', field: 'kind', op: 'isNot', value: 'canvas' }],
      match: 'and',
      sorts: [{ field: 'updated', dir: 'desc' }],
      fields: ['title', 'updated'],
      group: '01HZPROP',
      date: null,
    };
    const views = { 'p1:root': { active: 'v1', views: [view] } };
    expect((await call('PUT', '/api/prefs/views', views)).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ views });
    // La línea de tiempo guarda también su fecha de fin y su zoom.
    const timeline = { ...view, type: 'timeline', date: 'due', end: '01HZEND', zoom: 'month' };
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [timeline] } })).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ views: { 'p1:root': { active: 'v1', views: [timeline] } } });
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [{ ...view, type: 'gantt' }] } })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [{ ...timeline, zoom: 'year' }] } })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [] } })).status).toBe(400);
    // La tabla guarda el ancho de las columnas que se han ajustado a mano.
    const table = { ...view, widths: { title: 320, abc: 180 } };
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [table] } })).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ views: { 'p1:root': { active: 'v1', views: [table] } } });
    expect((await call('PUT', '/api/prefs/views', { 'p1:root': { active: 'v1', views: [{ ...view, widths: { title: -5 } }] } })).status).toBe(400);
  });

  it('rejects unknown prefs and bad values', async () => {
    expect((await call('PUT', '/api/prefs/password_hash', {})).status).toBe(404);
    // El laboratorio ya no existe: sus experimentos no se guardan.
    expect((await call('PUT', '/api/prefs/experiments', { foco: true })).status).toBe(404);
    expect((await call('PUT', '/api/prefs/keymap', { newNote: 5 })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/keymap', ['n'])).status).toBe(400);
    cookie = '';
    expect((await call('GET', '/api/prefs')).status).toBe(401);
  });
});
