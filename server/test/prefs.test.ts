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

  it('saves the lab experiments', async () => {
    expect((await call('PUT', '/api/prefs/experiments', { foco: true, celdas: false })).status).toBe(204);
    expect(await (await call('GET', '/api/prefs')).json()).toEqual({ experiments: { foco: true, celdas: false } });
    expect((await call('PUT', '/api/prefs/experiments', { foco: 'si' })).status).toBe(400);
    expect((await call('DELETE', '/api/prefs/experiments')).status).toBe(204);
  });

  it('rejects unknown prefs and bad values', async () => {
    expect((await call('PUT', '/api/prefs/password_hash', {})).status).toBe(404);
    expect((await call('PUT', '/api/prefs/keymap', { newNote: 5 })).status).toBe(400);
    expect((await call('PUT', '/api/prefs/keymap', ['n'])).status).toBe(400);
    cookie = '';
    expect((await call('GET', '/api/prefs')).status).toBe(401);
  });
});
