import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { scopeOf } from '../src/live.js';

let app: ReturnType<typeof createApp>;
let cookie = '';

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Lee eventos del canal hasta tener `n` de tipo «change».
async function changes(res: Response, n: number) {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let buf = '';
  const out: unknown[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += text.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      if (block.includes('event: change')) out.push(JSON.parse(block.split('data: ')[1]));
    }
  }
  await reader.cancel();
  return out;
}

beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  const res = await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

describe('live updates', () => {
  it('needs a session to listen', async () => {
    cookie = '';
    expect((await call('GET', '/api/events')).status).toBe(401);
  });

  it('announces each saved change with who made it, and skips failed ones', async () => {
    const stream = await call('GET', '/api/events');
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const heard = changes(stream, 2);
    const [profile] = await (await call('GET', '/api/profiles')).json();
    expect((await call('PATCH', '/api/notes/nope', { title: 'x' })).status).toBe(404);
    await call('POST', `/api/profiles/${profile.id}/notes`, { x: 0, y: 0, title: 'Hola' }, { 'x-canvian-client': 'movil' });
    await call('PUT', '/api/prefs/keymap', { newNote: 'q' });
    expect(await heard).toEqual([
      { scope: 'canvas', client: 'movil' },
      { scope: 'prefs', client: null },
    ]);
  });

  it('knows which part each write touches', () => {
    expect(scopeOf('GET', '/api/profiles/1/canvas')).toBeNull();
    expect(scopeOf('PUT', '/api/profiles/1/viewport')).toBeNull();
    expect(scopeOf('POST', '/api/media')).toBeNull();
    expect(scopeOf('POST', '/api/auth/login')).toBeNull();
    expect(scopeOf('PATCH', '/api/notes/1')).toBe('canvas');
    expect(scopeOf('POST', '/api/profiles/1/edges')).toBe('canvas');
    expect(scopeOf('PATCH', '/api/properties/1')).toBe('canvas');
    expect(scopeOf('PATCH', '/api/profiles/1')).toBe('profiles');
    expect(scopeOf('POST', '/api/profiles')).toBe('profiles');
    expect(scopeOf('PUT', '/api/prefs/keymap')).toBe('prefs');
  });
});
