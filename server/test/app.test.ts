import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let cookie = '';

const call = async (method: string, path: string, body?: unknown, withCookie = true) => {
  const res = await app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};

beforeEach(() => {
  app = createApp(openDb(':memory:'));
  cookie = '';
});

describe('auth', () => {
  it('starts without setup and rejects the API', async () => {
    expect(await (await call('GET', '/api/auth/status')).json()).toEqual({
      setupDone: false,
      authenticated: false,
    });
    expect((await call('GET', '/api/profiles')).status).toBe(401);
  });

  it('sets the password once, creates default profiles and logs in', async () => {
    expect((await call('POST', '/api/auth/setup', { password: 'corta' })).status).toBe(400);
    expect((await call('POST', '/api/auth/setup', { password: 'una-clave-larga' })).status).toBe(200);
    expect((await call('POST', '/api/auth/setup', { password: 'otra-clave-larga' })).status).toBe(409);

    const profiles = await (await call('GET', '/api/profiles')).json();
    expect(profiles.map((p: { name: string }) => p.name)).toEqual(['Personal', 'Trabajo']);
  });

  it('logs in with the right password only and logs out', async () => {
    await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
    cookie = '';
    expect((await call('POST', '/api/auth/login', { password: 'mal' })).status).toBe(401);
    expect((await call('GET', '/api/profiles')).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { password: 'una-clave-larga' })).status).toBe(200);
    expect((await call('GET', '/api/profiles')).status).toBe(200);

    const session = cookie;
    await call('POST', '/api/auth/logout');
    cookie = session;
    expect((await call('GET', '/api/profiles')).status).toBe(401);
  });
});

describe('profiles', () => {
  beforeEach(async () => {
    await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  });

  it('creates, renames and deletes profiles but keeps at least one', async () => {
    const created = await (await call('POST', '/api/profiles', { name: 'Estudio' })).json();
    expect(created.position).toBe(2);
    expect(created.color).toBe('#F28B82');

    const renamed = await (await call('PATCH', `/api/profiles/${created.id}`, { name: 'Máster' })).json();
    expect(renamed.name).toBe('Máster');
    expect(created.background).toBe('dots');
    const starry = await (await call('PATCH', `/api/profiles/${created.id}`, { background: 'stars' })).json();
    expect(starry.background).toBe('stars');
    expect((await call('PATCH', `/api/profiles/${created.id}`, { background: 'lava' })).status).toBe(400);

    expect((await call('DELETE', `/api/profiles/${created.id}`)).status).toBe(204);
    const [first, second] = await (await call('GET', '/api/profiles')).json();
    expect((await call('DELETE', `/api/profiles/${second.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/profiles/${first.id}`)).status).toBe(409);
  });

  it('remembers the viewport per profile', async () => {
    const [personal] = await (await call('GET', '/api/profiles')).json();
    const url = `/api/profiles/${personal.id}/viewport`;
    expect(await (await call('GET', url)).json()).toMatchObject({ x: 0, y: 0, zoom: 1 });
    expect((await call('PUT', url, { x: 120, y: -40, zoom: 0.5 })).status).toBe(204);
    expect(await (await call('GET', url)).json()).toMatchObject({ x: 120, y: -40, zoom: 0.5 });
  });
});
