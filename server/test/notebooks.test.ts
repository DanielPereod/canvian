import { describe, expect, it, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { AiError, clean, type Ai, type AiAsk } from '../src/ai/claude.js';
import { scopeOf } from '../src/live.js';

// La IA de mentira: responde según lo que se le pide y apunta cada pregunta.
let asked: AiAsk[] = [];
let failNext: AiError | null = null;
const fakeAi: Ai = {
  async ask(q) {
    asked.push(q);
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    const props = Object.keys((q.schema?.properties as object) ?? {});
    if (props.includes('questions')) return { text: '', json: { questions: ['¿Qué es una función?', '¿Para qué lo quieres?'] } };
    if (props.includes('topics'))
      return {
        text: '',
        json: {
          level: 'Sabe álgebra básica',
          topics: [
            { title: 'Límites', summary: 'Acercarse a un valor', depends_on: [] },
            { title: 'Derivadas', summary: 'Ritmo de cambio', depends_on: [0] },
            { title: 'Integrales', summary: 'Áreas', depends_on: [1, 5] },
          ],
        },
      };
    if (props.includes('brief'))
      return {
        text: '',
        json: {
          sources: [
            { kind: 'libro', title: 'OpenStax Calculus', url: 'https://openstax.org/books/calculus-volume-1', why: 'Manual abierto' },
            { kind: 'web', title: 'La que se quitó', url: 'https://quitada.example.org/', why: 'x' },
          ],
          note_ids: q.prompt.match(/id (\w{26})/)?.slice(1) ?? [],
          brief: 'La derivada es el límite de la velocidad media [OpenStax].',
        },
      };
    if (props.includes('stage')) return { text: '', json: { message: 'Un coche recorre t² metros. ¿A qué velocidad va en t = 3?', stage: 'entrada', gaps: ['velocidad instantánea'], solid: [] } };
    if (props.includes('covered'))
      return {
        text: '',
        json: {
          covered: [{ idea: 'Derivada como velocidad', ok: true }, { idea: 'Derivada cero', ok: false }],
          question: '¿Qué pasa cuando la derivada es 0?',
          links: ['Física del coche', 'Una que no existe'],
          lesson: '# Derivadas\n\nLa derivada es…',
          cards: [{ kind: 'dato', front: '¿Qué mide la derivada?', back: 'El ritmo de cambio' }],
        },
      };
    return { text: 'listo', json: null };
  },
};

let app: ReturnType<typeof createApp>;
let cookie = '';
let profileId = '';
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
};
const ok = async (method: string, path: string, body?: unknown) => {
  const res = await call(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

beforeEach(async () => {
  asked = [];
  failNext = null;
  app = createApp(openDb(':memory:'), { ai: fakeAi });
  cookie = '';
  await call('POST', '/auth/setup', { password: 'una-clave-larga' });
  profileId = (await ok('GET', '/profiles'))[0].id;
});

async function newNotebook() {
  const nb = await ok('POST', `/profiles/${profileId}/notebooks`, { title: 'Matemáticas', goal: 'Cálculo desde cero' });
  await ok('POST', `/notebooks/${nb.id}/diagnosis`);
  const planned = await ok('POST', `/notebooks/${nb.id}/plan`, { answers: [{ q: '¿Qué es una función?', a: 'Algo que da un valor' }] });
  return planned;
}

describe('notebooks', () => {
  it('goes from diagnosis to a syllabus with dependencies', async () => {
    const nb = await ok('POST', `/profiles/${profileId}/notebooks`, { title: 'Matemáticas' });
    expect(nb.status).toBe('diagnostico');
    const diag = await ok('POST', `/notebooks/${nb.id}/diagnosis`);
    expect(diag.notebook.diagnosis.map((d: { q: string }) => d.q)).toEqual(['¿Qué es una función?', '¿Para qué lo quieres?']);
    const planned = await ok('POST', `/notebooks/${nb.id}/plan`, { answers: [{ q: '¿Qué es una función?', a: 'Ni idea' }] });
    expect(planned.notebook.status).toBe('activo');
    expect(planned.notebook.level).toBe('Sabe álgebra básica');
    expect(planned.topics.map((t: { title: string }) => t.title)).toEqual(['Límites', 'Derivadas', 'Integrales']);
    const [lim, der, int] = planned.topics;
    expect(der.dependsOn).toEqual([lim.id]);
    // Una dependencia que no existe (o hacia delante) se descarta.
    expect(int.dependsOn).toEqual([der.id]);
    expect(planned.next).toBe(lim.id);
    expect(asked[1].prompt).toContain('Ni idea');
    const list = await ok('GET', `/profiles/${profileId}/notebooks`);
    expect(list[0]).toMatchObject({ title: 'Matemáticas', topics: 3, done: 0, next: 'Límites', due: 0 });
  });

  it('keeps topics with work when the syllabus is made again', async () => {
    const planned = await newNotebook();
    const der = planned.topics[1];
    await ok('POST', `/topics/${der.id}/turn`);
    const again = await ok('POST', `/notebooks/${planned.notebook.id}/plan`, { answers: [] });
    expect(again.topics.find((t: { title: string }) => t.title === 'Derivadas').id).toBe(der.id);
    expect(again.topics).toHaveLength(3);
  });

  it('runs a guided session and keeps what the person wrote if the AI fails', async () => {
    const planned = await newNotebook();
    const topic = planned.topics[0];
    const first = await ok('POST', `/topics/${topic.id}/turn`);
    expect(first.messages).toMatchObject([{ role: 'tutor', stage: 'entrada' }]);
    expect(first.topic).toMatchObject({ status: 'estudiando', stage: 'entrada', gaps: ['velocidad instantánea'] });
    expect(asked.at(-1)!.system).toMatch(/Pregunta antes de explicar/);
    failNext = new AiError('La sesión de Claude ha caducado', 'auth');
    const res = await call('POST', `/topics/${topic.id}/turn`, { text: '6 m/s' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('auth');
    const after = await ok('GET', `/topics/${topic.id}`);
    expect(after.messages.map((m: { role: string; body: string }) => [m.role, m.body])).toEqual([
      ['tutor', 'Un coche recorre t² metros. ¿A qué velocidad va en t = 3?'],
      ['yo', '6 m/s'],
    ]);
    // Reintentar sin texto sigue desde ahí.
    const retry = await ok('POST', `/topics/${topic.id}/turn`);
    expect(retry.messages).toHaveLength(3);
    expect(asked.at(-1)!.prompt).toContain('PERSONA [entrada]: 6 m/s');
  });

  it('picks sources automatically, never brings back a removed one and lets the person add their own', async () => {
    const planned = await newNotebook();
    const topic = planned.topics[1];
    // Una nota de la biblioteca que trata el tema.
    const note = await ok('POST', `/profiles/${profileId}/notes`, {
      id: '01JNOTADERIVADAS0000000001',
      kind: 'text',
      x: 0,
      y: 0,
      title: 'Derivadas en física',
      bodyText: 'Derivadas en física\nLa derivada de la posición es la velocidad',
      bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Derivadas en física' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'La derivada de la posición es la velocidad' }] }] }),
    });
    const t1 = await ok('POST', `/topics/${topic.id}/sources/auto`);
    expect(t1.sources.map((s: { title: string; origin: string; kind: string }) => [s.title, s.origin, s.kind])).toEqual([
      ['OpenStax Calculus', 'ia', 'libro'],
      ['La que se quitó', 'ia', 'web'],
      ['Derivadas en física', 'ia', 'nota'],
    ]);
    expect(t1.topic.brief).toContain('[OpenStax]');
    expect(asked.at(-1)!.web).toBe(true);
    const removed = t1.sources[1];
    await ok('PATCH', `/nb-sources/${removed.id}`, { removed: true });
    const t2 = await ok('POST', `/topics/${topic.id}/sources/auto`);
    expect(t2.sources.map((s: { title: string }) => s.title)).toEqual(['OpenStax Calculus', 'Derivadas en física']);
    expect(asked.at(-1)!.prompt).toMatch(/quitó[\s\S]*quitada\.example\.org/);
    // A mano: un enlace (con su título sacado de la dirección) y fijarlo.
    const t3 = await ok('POST', `/topics/${topic.id}/sources`, { url: 'https://es.khanacademy.org/math/calculus-1' });
    const mine = t3.sources.at(-1);
    expect(mine).toMatchObject({ origin: 'manual', title: 'es.khanacademy.org/math/calculus-1' });
    const t4 = await ok('PATCH', `/nb-sources/${mine.id}`, { pinned: true });
    expect(t4.sources.at(-1).pinned).toBe(1);
    // Añadir a mano la que se quitó la recupera.
    const t5 = await ok('POST', `/topics/${topic.id}/sources`, { url: 'https://quitada.example.org' });
    expect(t5.sources.some((s: { url: string | null }) => s.url === 'https://quitada.example.org/')).toBe(true);
    // Solo las mías: la IA no busca nada nuevo.
    await ok('PATCH', `/notebooks/${planned.notebook.id}`, { sourceMode: 'manual' });
    await ok('POST', `/topics/${topic.id}/sources/auto`);
    expect(asked.at(-1)!.prompt).toContain('No busques fuentes nuevas');
    void note;
  });

  it('saves the note in the library, reviews it and turns gaps into cards', async () => {
    const planned = await newNotebook();
    const topic = planned.topics[1];
    await ok('POST', `/profiles/${profileId}/notes`, {
      id: '01JFISICADELCOCHE000000001',
      kind: 'text',
      x: 0,
      y: 0,
      title: 'Física del coche',
      bodyText: 'Física del coche',
      bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Física del coche' }] }] }),
    });
    const saved = await ok('POST', `/topics/${topic.id}/note`, { markdown: 'La derivada mide lo rápido que cambia algo.' });
    expect(saved.note).toMatchObject({ title: 'Derivadas', markdown: 'La derivada mide lo rápido que cambia algo.' });
    expect(saved.review.question).toBe('¿Qué pasa cuando la derivada es 0?');
    // Solo se proponen notas que existen.
    expect(saved.review.links).toEqual([{ title: 'Física del coche', id: '01JFISICADELCOCHE000000001' }]);
    expect(saved.topic.lesson).toContain('# Derivadas');
    // La nota es normal y vive en la carpeta del cuaderno, que se crea sola.
    const { notes } = await ok('GET', `/profiles/${profileId}/canvas`);
    const mine = notes.find((n: { id: string }) => n.id === saved.note.id);
    const folder = notes.find((n: { id: string }) => n.id === mine.zoneId);
    expect(folder.title).toBe('Matemáticas');
    // Volver a guardar cambia la misma nota.
    const again = await ok('POST', `/topics/${topic.id}/note`, { markdown: 'Versión 2', review: false });
    expect(again.note.id).toBe(saved.note.id);
    expect(again.note.markdown).toBe('Versión 2');
    // Enlazarla con la que propone la revisión.
    const linked = await ok('POST', `/topics/${topic.id}/link`, { noteId: '01JFISICADELCOCHE000000001' });
    expect(linked.note.markdown).toContain('[[Física del coche]]');
    const { edges } = await ok('GET', `/profiles/${profileId}/canvas`);
    expect(edges.some((e: { fromId: string; toId: string }) => e.fromId === saved.note.id && e.toId === '01JFISICADELCOCHE000000001')).toBe(true);
    // Las tarjetas que acepta la persona, y el tema queda hecho.
    const done = await ok('POST', `/topics/${topic.id}/cards`, { cards: saved.review.cards, finish: true });
    expect(done.cards).toHaveLength(1);
    expect(done.topic.status).toBe('hecho');
    const links = await ok('GET', `/profiles/${profileId}/notebook-links`);
    expect(links).toEqual([{ noteId: saved.note.id, topicId: topic.id, topic: 'Derivadas', notebookId: planned.notebook.id, notebook: 'Matemáticas' }]);
  });

  it('keeps the note even if the review fails', async () => {
    const planned = await newNotebook();
    failNext = new AiError('Claude no ha podido responder');
    const saved = await ok('POST', `/topics/${planned.topics[0].id}/note`, { markdown: 'Lo que he entendido' });
    expect(saved.note.markdown).toBe('Lo que he entendido');
    expect(saved.review).toBeNull();
    expect(saved.reviewError).toMatch(/no ha podido/);
  });

  it('schedules reviews with FSRS, interleaves topics and tracks calibration and mastery', async () => {
    const planned = await newNotebook();
    const [lim, der] = planned.topics;
    await ok('POST', `/topics/${lim.id}/cards`, { cards: [{ front: 'L1', back: 'a' }, { front: 'L2', back: 'b' }] });
    await ok('POST', `/topics/${der.id}/cards`, { cards: [{ front: 'D1', back: 'c', kind: 'problema' }] });
    const due = await ok('GET', `/profiles/${profileId}/review`);
    // Intercalado: una de cada tema por turnos.
    expect(due.map((c: { front: string }) => c.front)).toEqual(['L1', 'D1', 'L2']);
    expect(due[0]).toMatchObject({ notebook: 'Matemáticas', topic: 'Límites' });
    expect(due[0].next).toHaveLength(4);
    const good = await ok('POST', `/nb-cards/${due[0].id}/grade`, { rating: 3, confidence: 95 });
    expect(new Date(good.due).getTime()).toBeGreaterThan(Date.now());
    await ok('POST', `/nb-cards/${due[1].id}/grade`, { rating: 1, confidence: 95 });
    expect((await call('POST', `/nb-cards/${due[1].id}/grade`, { rating: 7 })).status).toBe(400);
    const left = await ok('GET', `/profiles/${profileId}/review`);
    expect(left.map((c: { front: string }) => c.front)).toEqual(['L2', 'D1'].filter((f) => left.some((c: { front: string }) => c.front === f)));
    const full = await ok('GET', `/notebooks/${planned.notebook.id}`);
    expect(full.calibration.find((c: { confidence: number }) => c.confidence === 95)).toEqual({ confidence: 95, answers: 2, right: 50 });
    expect(full.topics[0].mastery.level).toBe('fragil');
    expect(full.topics[2].mastery.level).toBe('sin-tocar');
  });

  it('edits the syllabus by hand', async () => {
    const planned = await newNotebook();
    const added = await ok('POST', `/notebooks/${planned.notebook.id}/topics`, { title: 'Series' });
    expect(added.topics.at(-1).title).toBe('Series');
    const moved = await ok('PATCH', `/topics/${added.topics.at(-1).id}`, { position: 0, title: 'Sucesiones' });
    expect(moved.topics[0].title).toBe('Sucesiones');
    const gone = await ok('DELETE', `/topics/${moved.topics[0].id}`);
    expect(gone.topics.map((t: { title: string }) => t.title)).toEqual(['Límites', 'Derivadas', 'Integrales']);
    await ok('DELETE', `/notebooks/${planned.notebook.id}`);
    expect(await ok('GET', `/profiles/${profileId}/notebooks`)).toEqual([]);
  });

  it('connects Claude with a pasted token and reports errors', async () => {
    expect((await ok('GET', '/ai/claude')).connected).toBe(false);
    expect((await call('PUT', '/ai/claude/token', { token: 'hola' })).status).toBe(400);
    const st = await ok('PUT', '/ai/claude/token', { token: ' sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789 ' });
    expect(st).toMatchObject({ connected: true, tokenHint: '…456789' });
    expect((await ok('PUT', '/ai/claude/model', { model: 'sonnet' })).model).toBe('sonnet');
    expect((await call('PUT', '/ai/claude/model', { model: 'gpt' })).status).toBe(400);
    expect((await ok('POST', '/ai/claude/test')).ok).toBe(true);
    failNext = new AiError('Conecta Claude', 'off');
    expect((await call('POST', '/ai/claude/test')).status).toBe(409);
    await ok('DELETE', '/ai/claude/token');
    expect((await ok('GET', '/ai/claude')).connected).toBe(false);
  });

  it('tells other devices about notebook changes but not about the Claude connection', () => {
    expect(scopeOf('POST', '/api/topics/x/turn')).toBe('nb');
    expect(scopeOf('POST', '/api/profiles/p/notebooks')).toBe('nb');
    expect(scopeOf('POST', '/api/nb-cards/x/grade')).toBe('nb');
    expect(scopeOf('PUT', '/api/ai/claude/token')).toBeNull();
  });

  it('reads the sign-in link and token through terminal colors', () => {
    expect(clean('\x1b[37m\x1b]8;id=1;https://claude.ai/oauth/authorize?X\x07hola\x1b]8;;\x07\x1b[39m')).toBe('hola');
  });
});

describe('notebooks over MCP', () => {
  it('studies, saves progress and reviews from a Claude chat', async () => {
    const planned = await newNotebook();
    const token = (await ok('POST', '/mcp/token')).token;
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://canvian.test/mcp/${token}`), { fetch: async (url, init) => app.request(String(url), init as RequestInit) }));
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      if (res.isError) throw new Error(res.content[0].text);
      try {
        return JSON.parse(res.content[0].text);
      } catch {
        return res.content[0].text;
      }
    };
    expect((await tool('list_notebooks'))[0]).toMatchObject({ title: 'Matemáticas', next: 'Límites' });
    const study = await tool('study_topic', { notebook: 'mate' });
    expect(study).toContain('Pregunta antes de explicar');
    expect(study).toContain('«Límites»');
    const topicId = planned.topics[0].id;
    await tool('save_topic_progress', { topic: topicId, gaps: ['límites laterales'], status: 'estudiando' });
    await tool('add_notebook_cards', { topic: topicId, cards: [{ front: '¿Qué es un límite?', back: 'A dónde se acerca' }] });
    const nb = await tool('get_notebook', { notebook: 'Matemáticas' });
    expect(nb.topics[0]).toMatchObject({ status: 'estudiando', gaps: ['límites laterales'] });
    const due = await tool('due_cards');
    expect(due).toHaveLength(1);
    expect(await tool('grade_card', { card: due[0].id, rating: 4 })).toMatch(/^Vuelve el \d{4}-/);
    await expect(tool('get_notebook', { notebook: 'Historia' })).rejects.toThrow(/No hay ningún cuaderno/);
    const prompt = await client.getPrompt({ name: 'estudiar_tema', arguments: { notebook: 'Matemáticas', topic: 'Derivadas' } });
    expect((prompt.messages[0].content as { text: string }).text).toContain('«Derivadas»');
  });
});
