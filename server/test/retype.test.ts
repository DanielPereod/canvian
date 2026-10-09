import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { convertValue } from '../src/routes/properties.js';

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

beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
});

describe('convertValue', () => {
  it('keeps what fits the new type and drops the rest', () => {
    expect(convertValue('3,5', 'number')).toBe(3.5);
    expect(convertValue('hola', 'number')).toBeUndefined();
    expect(convertValue('a, b', 'tags')).toEqual(['a', 'b']);
    expect(convertValue(['a', 'b'], 'select')).toBe('a');
    expect(convertValue(['a', 'b'], 'text')).toBe('a, b');
    expect(convertValue(7, 'text')).toBe('7');
    expect(convertValue('2026-10-09', 'date')).toBe('2026-10-09');
    expect(convertValue('mañana', 'date')).toBeUndefined();
    expect(convertValue(true, 'checkbox')).toBe(true);
    expect(convertValue('sí', 'checkbox')).toBeUndefined();
  });
});

describe('changing a property type', () => {
  it('converts every note value and collects options', async () => {
    const [profile] = await (await call('GET', '/api/profiles')).json();
    const def = await (await call('POST', `/api/profiles/${profile.id}/properties`, { name: 'Estado', type: 'text' })).json();
    const a = await (await call('POST', `/api/profiles/${profile.id}/notes`, { title: 'A', x: 0, y: 0, props: { [def.id]: 'Hecho' } })).json();
    const b = await (await call('POST', `/api/profiles/${profile.id}/notes`, { title: 'B', x: 0, y: 0, props: { [def.id]: 'Pendiente', otra: 1 } })).json();

    const res = await call('PATCH', `/api/properties/${def.id}`, { type: 'select' });
    expect(res.status).toBe(200);
    const saved = await res.json();
    expect(saved.type).toBe('select');
    expect([...saved.options].sort()).toEqual(['Hecho', 'Pendiente']);

    await call('PATCH', `/api/properties/${def.id}`, { type: 'number' });
    const canvas = await (await call('GET', `/api/profiles/${profile.id}/canvas`)).json();
    const props = (id: string) => JSON.parse(canvas.notes.find((n: { id: string }) => n.id === id).props);
    expect(props(a.id)).toEqual({});
    expect(props(b.id)).toEqual({ otra: 1 });
  });
});
