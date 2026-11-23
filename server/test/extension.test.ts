import { describe, expect, it, beforeEach } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { subjectKey } from '../src/extension/routes.js';

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
const ext = (method: string, path: string, body?: unknown, key = token) =>
  app.request(`/ext${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let profileId = '';
beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  cookie = '';
  await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  token = (await (await call('POST', '/api/extension/token')).json()).token;
  profileId = (await (await call('GET', '/api/profiles')).json())[0].id;
});

type Row = { id: string; title: string; zoneId: string | null; bodyText: string; bodyJson: string; props: string };
const notesOf = async () => (await (await call('GET', `/api/profiles/${profileId}/canvas`)).json()).notes as Row[];
const newNote = async (title: string, markdown: string) => ({ clip: await (await ext('POST', '/clip', { profile: profileId, title, markdown })).json() });

describe('browser extension', () => {
  it('needs its key', async () => {
    expect((await ext('GET', '/profiles', undefined, 'otra')).status).toBe(401);
    const res = await (await ext('GET', '/profiles')).json();
    expect(res.profiles.map((p: { name: string }) => p.name)).toEqual(['Personal', 'Trabajo']);
    await call('DELETE', '/api/extension/token');
    expect((await ext('GET', '/profiles')).status).toBe(401);
  });

  it('clips into «Recortes» or the chosen folder, with its source', async () => {
    const clip = await (
      await ext('POST', '/clip', {
        profile: profileId,
        title: 'Cómo hacer pan',
        markdown: '## Ingredientes\n\n- Harina\n- Agua\n\n> Amasar bien.',
        url: 'https://example.com/pan',
        tags: ['cocina'],
        properties: { Autor: 'Ana' },
      })
    ).json();
    expect(clip.path).toBe('Recortes > Cómo hacer pan');
    expect(clip.open).toMatch(new RegExp(`/#nota/${profileId}/${clip.id}$`));
    let notes = await notesOf();
    const note = notes.find((n) => n.id === clip.id)!;
    expect(note.bodyText).toContain('Ingredientes');
    expect(note.bodyText).toContain('Amasar bien.');
    const props = Object.values(JSON.parse(note.props));
    expect(props).toContain('https://example.com/pan');
    expect(props).toContain('Ana');
    expect(JSON.stringify(props)).toContain('cocina');

    // La segunda va a la misma «Recortes»; y a otra carpeta si se elige.
    const folders = (await (await ext('GET', `/folders?profile=${profileId}`)).json()).folders as { id: string; path: string }[];
    const recortes = folders.find((f) => f.path === 'Recortes')!;
    const other = await (await ext('POST', '/clip', { profile: profileId, parent: clip.id, title: 'Masa madre', markdown: 'Texto' })).json();
    expect(other.path).toBe('Recortes > Cómo hacer pan > Masa madre');
    await ext('POST', '/clip', { profile: profileId, title: 'Otra', markdown: '' });
    notes = await notesOf();
    expect(notes.filter((n) => n.title === 'Recortes')).toHaveLength(1);
    expect(notes.find((n) => n.title === 'Otra')!.zoneId).toBe(recortes.id);
    expect((await ext('POST', '/clip', { profile: profileId, parent: 'no-existe', title: 'X' })).status).toBe(400);
  });

  it('links tasks to a mail thread and follows them when the note changes', async () => {
    const { clip } = await newNote('Proyecto', '- [ ] Revisar contrato 📅 2026-12-01 ⏫\n- [ ] Llamar a Luis');
    const thread = { profile: profileId, thread: 'AAQkThread1', subject: 'Contrato de obra', url: 'https://outlook.office.com/mail/id/AAQkThread1' };

    // Nada vinculado todavía.
    expect((await (await ext('GET', `/thread?profile=${profileId}&thread=AAQkThread1&subject=x`)).json()).tasks).toEqual([]);

    // Buscar y vincular una que ya existe.
    const found = (await (await ext('GET', `/tasks?profile=${profileId}&q=contrato`)).json()).tasks;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ text: 'Revisar contrato', due: '2026-12-01', priority: 'high', status: 'todo', note: { path: 'Recortes > Proyecto' } });
    let linked = (await (await ext('POST', '/thread/link', { ...thread, task: found[0].id })).json()).tasks;
    expect(linked).toHaveLength(1);
    expect(linked[0].text).toBe('Revisar contrato');
    // Se le puso un id de bloque a la casilla, que sale en el enlace para abrirla.
    let body = (await notesOf()).find((n) => n.id === clip.id)!.bodyJson;
    const blockId = /"blockId":"([a-z0-9]+)"/.exec(body)![1];
    expect(linked[0].open).toContain(`/${clip.id}/${blockId}`);

    // Una nueva desde el correo, en «Tareas» (que se crea).
    linked = (await (await ext('POST', '/thread/task', { ...thread, text: 'Mandar presupuesto', due: '2026-12-05', priority: 'medium' })).json()).tasks;
    expect(linked.map((t: { text: string }) => t.text)).toEqual(['Revisar contrato', 'Mandar presupuesto']);
    expect(linked[1].note.path).toBe('Tareas');

    // Otra casilla delante: la vinculada se sigue encontrando.
    const proyecto = (await notesOf()).find((n) => n.id === clip.id)!;
    const doc = JSON.parse(proyecto.bodyJson);
    const list = doc.content.find((b: { type: string }) => b.type === 'taskList');
    list.content.unshift({ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Primera' }] }] });
    await call('PATCH', `/api/notes/${clip.id}`, { bodyJson: JSON.stringify(doc) });

    // Una respuesta («RE: …») con otro id encuentra las mismas por el asunto.
    const again = (await (await ext('GET', `/thread?profile=${profileId}&thread=otro&subject=${encodeURIComponent('RE: RV: Contrato de obra')}`)).json()).tasks;
    expect(again.map((t: { text: string }) => t.text)).toEqual(['Revisar contrato', 'Mandar presupuesto']);

    // Hecha desde el correo: se marca en la nota.
    await ext('PATCH', '/task', { profile: profileId, task: again[0].id, status: 'done' });
    body = (await notesOf()).find((n) => n.id === clip.id)!.bodyText;
    expect(body).toMatch(/Revisar contrato.*✅/);
    const after = (await (await ext('GET', `/thread?profile=${profileId}&thread=AAQkThread1`)).json()).tasks;
    expect(after[0]).toMatchObject({ text: 'Revisar contrato', status: 'done' });

    // La vista general: un hilo (dos ids, mismo asunto) con sus dos tareas.
    const overview = (await (await ext('GET', `/overview?profile=${profileId}`)).json()).threads;
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({ subject: 'Contrato de obra', subjectKey: 'contrato de obra', counts: { total: 2, open: 1, done: 1 } });
    expect(overview[0].threads).toEqual(['AAQkThread1']);
    expect(overview[0].tasks.map((t: { text: string }) => t.text)).toEqual(['Revisar contrato', 'Mandar presupuesto']);
    // Y la web la ve en el lienzo, para enseñar el hilo en la casilla.
    const canvas = await (await call('GET', `/api/profiles/${profileId}/canvas`)).json();
    expect(canvas.mailLinks).toContainEqual({ noteId: clip.id, blockId, subject: 'Contrato de obra', url: thread.url });

    // Quitar el vínculo deja la tarea.
    expect((await ext('DELETE', `/link/${after[0].linkId}`)).status).toBe(204);
    expect((await (await ext('GET', `/thread?profile=${profileId}&thread=AAQkThread1`)).json()).tasks).toHaveLength(1);
  });

  it('downloads the extension already configured', async () => {
    const res = await call('GET', `/api/extension/download.zip?base=${encodeURIComponent('https://notas.example.net/')}`);
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const files: Record<string, Buffer> = {};
    let at = 0;
    while (buf.readUInt32LE(at) === 0x04034b50) {
      const size = buf.readUInt32LE(at + 18);
      const nameLen = buf.readUInt16LE(at + 26);
      const name = buf.subarray(at + 30, at + 30 + nameLen).toString();
      files[name] = inflateRawSync(buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size));
      at += 30 + nameLen + size;
    }
    expect(Object.keys(files)).toContain('canvian-extension/outlook/outlook.js');
    expect(Object.keys(files)).toContain('canvian-extension/icons/128.png');
    expect(files['canvian-extension/config.js'].toString()).toContain(`"token":"${token}"`);
    expect(files['canvian-extension/config.js'].toString()).toContain('"url":"https://notas.example.net"');
    const manifest = JSON.parse(files['canvian-extension/manifest.json'].toString());
    expect(manifest.host_permissions).toEqual(['https://notas.example.net/*']);
  });

  it('uses the profile open in the web unless told otherwise', async () => {
    const profiles = (await (await call('GET', '/api/profiles')).json()) as { id: string; name: string }[];
    const trabajo = profiles.find((p) => p.name === 'Trabajo')!;
    expect((await (await ext('GET', '/profiles')).json()).active).toBe(profileId);
    expect((await call('PUT', `/api/profiles/${trabajo.id}/active`)).status).toBe(204);
    expect((await (await ext('GET', '/profiles')).json()).active).toBe(trabajo.id);
    const clip = await (await ext('POST', '/clip', { title: 'En el trabajo', markdown: '' })).json();
    expect(clip.open).toContain(`/#nota/${trabajo.id}/`);
    // Con perfil en la llamada, ese.
    const mine = await (await ext('POST', '/clip', { profile: profileId, title: 'En casa', markdown: '' })).json();
    expect(mine.open).toContain(`/#nota/${profileId}/`);
  });

  it('normalizes subjects', () => {
    expect(subjectKey('RE: RV: [EXTERNAL] Contrato de Obra ')).toBe('contrato de obra');
    expect(subjectKey('Fwd: Presupuesto  ÁTICO')).toBe('presupuesto atico');
    expect(subjectKey('RE:')).toBeNull();
  });
});
