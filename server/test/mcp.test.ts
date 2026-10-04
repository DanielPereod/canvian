import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { localDay } from '../src/mcp/server.js';

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

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://canvian.test/mcp/${token}`), {
    fetch: async (url, init) => app.request(String(url), init as RequestInit),
  });
  await client.connect(transport);
  return client;
}

const tool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const raw = res.content[0].text;
  if (res.isError) throw new Error(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

let token = '';
beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  token = (await (await call('POST', '/api/mcp/token')).json()).token;
});

describe('mcp', () => {
  it('needs the token', async () => {
    const res = await app.request('/mcp/otra', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await (await call('GET', '/api/mcp')).json()).toEqual({ enabled: true, fromEnv: false, token, publicUrl: null });
    expect((await call('PUT', '/api/mcp/public-url', { url: 'ftp://x' })).status).toBe(400);
    expect((await (await call('PUT', '/api/mcp/public-url', { url: 'https://notas.example.org/' })).json()).publicUrl).toBe('https://notas.example.org');
    await call('DELETE', '/api/mcp/token');
    await expect(connect(token)).rejects.toThrow();
  });

  it('accepts the token as a bearer header too', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain('search_notes');
  });

  it('creates, finds, reads and edits notes with links', async () => {
    const client = await connect(token);
    const casa = (await tool(client, 'create_note', { title: 'Casa', markdown: 'Todo lo de **casa**.' })).created;
    const bano = (await tool(client, 'create_note', { title: 'Baño', parent: 'Casa', markdown: 'Ver [[Casa]] y [[Nada]].\n\n- [ ] Elegir azulejos 📅 2026-10-10 ⏫' }));
    expect(bano.created.path).toBe('Casa > Baño');
    expect(bano.linksToMissingNotes).toEqual(['Nada']);

    const hits = await tool(client, 'search_notes', { query: 'azulej' });
    expect(hits.map((h: { title: string }) => h.title)).toEqual(['Baño']);

    const note = await tool(client, 'get_note', { note: 'Casa > Baño' });
    expect(note.parent.id).toBe(casa.id);
    expect(note.linkedNotes.map((n: { title: string }) => n.title)).toEqual(['Casa']);
    expect(note.tasks[0]).toMatchObject({ text: 'Elegir azulejos', due: '2026-10-10', priority: 'high' });
    expect(note.markdown).toContain('Ver [[Casa]]');
    expect(note.markdown).not.toContain('# Baño');

    await tool(client, 'update_note', { note: note.id, title: 'Baño grande', append: 'Presupuesto: 3000 €' });
    const edited = await tool(client, 'get_note', { note: note.id });
    expect(edited.title).toBe('Baño grande');
    expect(edited.markdown.endsWith('Presupuesto: 3000 €')).toBe(true);

    // La web lo ve igual: título como primer bloque y texto plano para buscar.
    const canvas = await (await call('GET', `/api/profiles/${(await (await call('GET', '/api/profiles')).json())[0].id}/canvas`)).json();
    const row = canvas.notes.find((n: { id: string }) => n.id === note.id);
    expect(row.title).toBe('Baño grande');
    expect(JSON.parse(row.bodyJson).content[0]).toMatchObject({ type: 'heading', content: [{ text: 'Baño grande' }] });
    expect(canvas.edges).toHaveLength(1);

    expect(await tool(client, 'list_notes')).toContain('- Casa');
  });

  it('handles tasks: inbox, today, done', async () => {
    const client = await connect(token);
    const today = localDay();
    const added = (await tool(client, 'add_task', { text: 'Llamar al banco #pelas', due: today })).added;
    expect(added).toMatchObject({ text: 'Llamar al banco', due: today, tags: ['pelas'], note: 'Tareas' });
    const sub = (await tool(client, 'add_task', { text: 'Buscar el número', subtask_of: added.id })).added;
    expect(sub.subtaskOf).toBe(added.id);
    await tool(client, 'add_task', { text: 'Otra cosa', priority: 'low' });

    const todays = await tool(client, 'list_tasks', { when: 'today' });
    expect(todays.tasks.map((t: { text: string }) => t.text)).toEqual(['Llamar al banco']);

    const done = (await tool(client, 'update_task', { task: added.id, status: 'done' })).updated;
    expect(done).toMatchObject({ status: 'done', done: today });
    const open = await tool(client, 'list_tasks');
    expect(open.tasks.map((t: { text: string }) => t.text)).toEqual(['Otra cosa']);

    const activity = await tool(client, 'recent_activity');
    expect(activity.tasksDone).toHaveLength(2);
    expect(activity.created.map((n: { title: string }) => n.title)).toEqual(['Tareas']);
  });

  it('organises: move, archive, properties, profiles', async () => {
    const client = await connect(token);
    await tool(client, 'create_note', { title: 'Proyectos' });
    await tool(client, 'create_note', { title: 'Web', parent: 'Proyectos' });
    await expect(tool(client, 'move_note', { note: 'Proyectos', parent: 'Web' })).rejects.toThrow(/dentro de sí misma/);
    expect(await tool(client, 'move_note', { note: 'Web', parent: null })).toBe('Ahora está en: Web');

    await tool(client, 'set_property', { note: 'Web', property: 'Estado', value: 'En marcha' });
    await tool(client, 'set_property', { note: 'Web', property: 'Etiquetas', value: ['dev', '#ideas'] });
    expect((await tool(client, 'get_note', { note: 'Web' })).properties).toEqual({ Estado: 'En marcha', Etiquetas: ['dev', 'ideas'] });
    expect((await tool(client, 'search_notes', { tag: 'ideas' })).map((n: { title: string }) => n.title)).toEqual(['Web']);

    await tool(client, 'archive_note', { note: 'Web' });
    expect(await tool(client, 'search_notes', { query: 'web' })).toEqual([]);
    expect(await tool(client, 'search_notes', { query: 'web', include_archived: true })).toHaveLength(1);

    await tool(client, 'create_note', { title: 'Informe', profile: 'Trabajo' });
    expect(await tool(client, 'search_notes', { query: 'informe' })).toEqual([]);
    expect(await tool(client, 'search_notes', { query: 'informe', profile: 'trabajo' })).toHaveLength(1);
  });
});
