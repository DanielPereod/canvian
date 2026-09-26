import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let dir: string;
let cookie = '';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canvian-media-'));
  app = createApp(openDb(':memory:'), { mediaDir: dir });
  const res = await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'una-clave-larga' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

const upload = (body: Buffer, type: string, withCookie = true) =>
  app.request('/api/media', { method: 'POST', headers: { 'content-type': type, ...(withCookie ? { cookie } : {}) }, body: new Uint8Array(body) });

describe('media', () => {
  it('stores a pasted image on disk and serves it back', async () => {
    const res = await upload(png, 'image/png');
    expect(res.status).toBe(201);
    const { url, kind } = await res.json();
    expect(kind).toBe('image');
    expect(url).toMatch(/^\/api\/media\/[0-9A-Z]{26}\.png$/);
    expect(readdirSync(dir)).toHaveLength(1);

    const got = await app.request(url, { headers: { cookie } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(png);
  });

  it('answers byte ranges so video can seek', async () => {
    const { url } = await (await upload(png, 'video/mp4')).json();
    const part = await app.request(url, { headers: { cookie, range: 'bytes=4-7' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-7/${png.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(png.subarray(4, 8));
    const tail = await app.request(url, { headers: { cookie, range: 'bytes=-2' } });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(png.subarray(-2));
    expect((await app.request(url, { headers: { cookie, range: 'bytes=999-' } })).status).toBe(416);
  });

  it('refuses scripts, empty files, strangers and made-up names', async () => {
    expect((await upload(Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
    expect((await upload(Buffer.from('<p>'), 'text/html')).status).toBe(415);
    expect((await upload(Buffer.alloc(0), 'image/png')).status).toBe(400);
    expect((await upload(png, 'image/png', false)).status).toBe(401);
    const { url } = await (await upload(png, 'image/png')).json();
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request('/api/media/..%2Fcanvian.db', { headers: { cookie } })).status).toBe(404);
    expect((await app.request('/api/media/01ARZ3NDEKTSV4RRFFQ69G5FAV.png', { headers: { cookie } })).status).toBe(404);
  });
});
