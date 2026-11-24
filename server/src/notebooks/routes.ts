import { Hono, type Context } from 'hono';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { nbCards, nbSources, nbTopics, notebooks, notes, profiles } from '../db/schema.js';
import { AiError, MODELS, TOKEN_RE, aiStatus, forgetToken, saveModel, saveToken, type Ai, type loginFlow } from '../ai/claude.js';
import { bodyMarkdown, connect, contentOf, createNote, editDoc, liveNotes, newDoc, noteTitle, saveNote } from '../mcp/notes.js';
import {
  NbError,
  addCards,
  addMessage,
  addSources,
  calibration,
  createNotebook,
  dueCards,
  grade,
  list,
  masteryOf,
  messagesOf,
  notebookOf,
  preview,
  setSyllabus,
  sourcesFor,
  suggestNext,
  topicOf,
  topicsOf,
  touch,
  type CardRow,
  type Topic,
} from './model.js';
import { diagnosis, findSources, plan, reviewNote, turn, type NoteCandidate } from './tutor.js';

type Hub = { publish: (e: { scope: 'canvas' | 'nb'; client: string | null }) => void };

const param = (c: Context, k: string) => c.req.param(k) ?? '';
const json = async (c: Context) => c.req.json().catch(() => null);
const nowIso = () => new Date().toISOString();

// Los errores esperables (de la IA o de los datos) vuelven como { error, code }.
function fail(c: Context, e: unknown) {
  if (e instanceof NbError) return c.json({ error: e.message }, e.status);
  if (e instanceof AiError) return c.json({ error: e.message, code: e.code }, e.code === 'fail' ? 502 : 409);
  throw e;
}
const guard =
  (fn: (c: Context) => Response | Promise<Response>) =>
  async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      return fail(c, e);
    }
  };

const topicOut = (t: Topic) => ({ ...t, dependsOn: list(t.dependsOn), gaps: list(t.gaps), solid: list(t.solid) });
const cardOut = (r: CardRow, extra: Record<string, unknown> = {}) => ({
  id: r.id,
  notebookId: r.notebookId,
  topicId: r.topicId,
  kind: r.kind,
  front: r.front,
  back: r.back,
  due: r.due,
  reps: r.reps,
  lapses: r.lapses,
  state: r.state,
  ...extra,
});

const ftsAny = (input: string) => {
  const terms = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' OR ') : null;
};

export function notebookRoutes(db: Db, opts: { ai: Ai; login: ReturnType<typeof loginFlow>; hub?: Hub }) {
  const r = new Hono();
  const { ai } = opts;
  // Sin «client»: también esta pestaña recarga la biblioteca, que no sabe nada de la nota nueva.
  const libraryChanged = (_c: Context) => opts.hub?.publish({ scope: 'canvas', client: null });

  // ── La conexión con Claude (Configuración › Asistentes IA) ───────────
  r.get('/ai/claude', (c) => c.json(aiStatus(db)));
  r.post(
    '/ai/claude/login',
    guard(async (c) => c.json(await opts.login.start())),
  );
  r.post(
    '/ai/claude/login/code',
    guard(async (c) => {
      const body = z.object({ code: z.string().trim().min(4).max(2000) }).safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Pega el código que te da Claude' }, 400);
      await opts.login.code(body.data.code);
      return c.json(aiStatus(db));
    }),
  );
  r.delete('/ai/claude/login', (c) => {
    opts.login.cancel();
    return c.body(null, 204);
  });
  r.put('/ai/claude/token', async (c) => {
    const body = z.object({ token: z.string().trim().max(500) }).safeParse(await json(c));
    const token = body.success ? TOKEN_RE.exec(body.data.token)?.[0] : null;
    if (!token) return c.json({ error: 'Eso no parece un token de Claude (empieza por sk-ant-oat01-)' }, 400);
    saveToken(db, token);
    return c.json(aiStatus(db));
  });
  r.delete('/ai/claude/token', (c) => {
    forgetToken(db);
    return c.body(null, 204);
  });
  r.put('/ai/claude/model', async (c) => {
    const body = z.object({ model: z.enum(MODELS) }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Modelo no válido' }, 400);
    saveModel(db, body.data.model);
    return c.json(aiStatus(db));
  });
  r.post(
    '/ai/claude/test',
    guard(async (c) => {
      const res = await ai.ask({ system: 'Responde exactamente con la palabra: listo', prompt: '¿Estás ahí?' });
      return c.json({ ok: true, reply: res.text.slice(0, 80), status: aiStatus(db) });
    }),
  );

  // ── Cuadernos ───────────────────────────────────────────────────────
  const profileExists = (id: string) => !!db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).get();

  const summary = (nbId: string) => {
    const nb = notebookOf(db, nbId);
    const topics = topicsOf(db, nbId);
    const mastery = masteryOf(db, nbId);
    const next = suggestNext(topics, mastery);
    const due = Object.values(mastery).reduce((s, m) => s + m.due, 0) + db.select({ n: sql<number>`count(*)` }).from(nbCards).where(and(eq(nbCards.notebookId, nbId), isNull(nbCards.topicId), sql`${nbCards.due} <= ${nowIso()}`)).get()!.n;
    return {
      ...nb,
      diagnosis: JSON.parse(nb.diagnosis || '[]') as { q: string; a: string }[],
      topics: topics.length,
      done: topics.filter((t) => t.status === 'hecho').length,
      next: next ? (topics.find((t) => t.id === next)?.title ?? null) : null,
      due,
    };
  };

  r.get('/profiles/:pid/notebooks', (c) => {
    const rows = db.select().from(notebooks).where(eq(notebooks.profileId, param(c, 'pid'))).orderBy(asc(notebooks.position), asc(notebooks.createdAt)).all();
    return c.json(rows.map((nb) => summary(nb.id)));
  });

  r.post('/profiles/:pid/notebooks', async (c) => {
    const pid = param(c, 'pid');
    if (!profileExists(pid)) return c.json({ error: 'Perfil no encontrado' }, 404);
    const body = z.object({ title: z.string().trim().min(1).max(120), goal: z.string().trim().max(1000).nullish() }).safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Dale un nombre al cuaderno' }, 400);
    return c.json(summary(createNotebook(db, pid, body.data).id), 201);
  });

  const full = (nbId: string) => {
    const topics = topicsOf(db, nbId);
    const mastery = masteryOf(db, nbId);
    return {
      notebook: summary(nbId),
      topics: topics.map((t) => ({ ...topicOut(t), mastery: mastery[t.id] })),
      sources: sourcesFor(db, nbId, null).filter((s) => s.topicId === null),
      next: suggestNext(topics, mastery),
      calibration: calibration(db, nbId),
    };
  };

  r.get('/notebooks/:id', guard((c) => c.json(full(notebookOf(db, param(c, 'id')).id))));

  r.patch(
    '/notebooks/:id',
    guard(async (c) => {
      const nb = notebookOf(db, param(c, 'id'));
      const body = z
        .object({
          title: z.string().trim().min(1).max(120),
          goal: z.string().trim().max(1000).nullable(),
          sourceMode: z.enum(['auto', 'manual']),
          folderId: z.string().nullable(),
          color: z.string().max(20),
          position: z.number().int(),
        })
        .partial()
        .safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
      db.update(notebooks).set({ ...body.data, updatedAt: nowIso() }).where(eq(notebooks.id, nb.id)).run();
      return c.json(full(nb.id));
    }),
  );

  r.delete(
    '/notebooks/:id',
    guard((c) => {
      // Las notas que escribió la persona se quedan en la biblioteca.
      db.delete(notebooks).where(eq(notebooks.id, notebookOf(db, param(c, 'id')).id)).run();
      return c.body(null, 204);
    }),
  );

  // Diagnóstico y temario.
  r.post(
    '/notebooks/:id/diagnosis',
    guard(async (c) => {
      const nb = notebookOf(db, param(c, 'id'));
      const questions = await diagnosis(ai, nb);
      db.update(notebooks).set({ diagnosis: JSON.stringify(questions.map((q) => ({ q, a: '' }))), updatedAt: nowIso() }).where(eq(notebooks.id, nb.id)).run();
      return c.json(full(nb.id));
    }),
  );

  r.post(
    '/notebooks/:id/plan',
    guard(async (c) => {
      const nb = notebookOf(db, param(c, 'id'));
      const body = z.object({ answers: z.array(z.object({ q: z.string().max(1000), a: z.string().max(4000) })).max(12) }).safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Respuestas no válidas' }, 400);
      db.update(notebooks).set({ diagnosis: JSON.stringify(body.data.answers) }).where(eq(notebooks.id, nb.id)).run();
      const out = await plan(ai, notebookOf(db, nb.id), body.data.answers);
      db.update(notebooks).set({ level: out.level.slice(0, 500), status: 'activo', updatedAt: nowIso() }).where(eq(notebooks.id, nb.id)).run();
      setSyllabus(db, nb.id, out.topics);
      return c.json(full(nb.id));
    }),
  );

  // Editar el temario a mano.
  r.post(
    '/notebooks/:id/topics',
    guard(async (c) => {
      const nb = notebookOf(db, param(c, 'id'));
      const body = z.object({ title: z.string().trim().min(1).max(200), summary: z.string().trim().max(600).nullish() }).safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Dale un título al tema' }, 400);
      const n = topicsOf(db, nb.id).length;
      db.insert(nbTopics).values({ id: ulid(), notebookId: nb.id, position: n, title: body.data.title, summary: body.data.summary ?? null }).run();
      if (nb.status === 'diagnostico') db.update(notebooks).set({ status: 'activo' }).where(eq(notebooks.id, nb.id)).run();
      touch(db, nb.id);
      return c.json(full(nb.id), 201);
    }),
  );

  r.patch(
    '/topics/:id',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      const body = z
        .object({
          title: z.string().trim().min(1).max(200),
          summary: z.string().trim().max(600).nullable(),
          status: z.enum(['pendiente', 'estudiando', 'hecho']),
          position: z.number().int(),
          dependsOn: z.array(z.string()).max(30),
        })
        .partial()
        .safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
      const { dependsOn, position, ...rest } = body.data;
      if (position !== undefined) {
        const ids = topicsOf(db, t.notebookId).map((x) => x.id).filter((id) => id !== t.id);
        ids.splice(Math.max(0, Math.min(position, ids.length)), 0, t.id);
        ids.forEach((id, i) => db.update(nbTopics).set({ position: i }).where(eq(nbTopics.id, id)).run());
      }
      db.update(nbTopics)
        .set({ ...rest, ...(dependsOn ? { dependsOn: JSON.stringify(dependsOn.filter((d) => d !== t.id)) } : {}), updatedAt: nowIso() })
        .where(eq(nbTopics.id, t.id))
        .run();
      touch(db, t.notebookId);
      return c.json(full(t.notebookId));
    }),
  );

  r.delete(
    '/topics/:id',
    guard((c) => {
      const t = topicOf(db, param(c, 'id'));
      db.delete(nbTopics).where(eq(nbTopics.id, t.id)).run();
      touch(db, t.notebookId);
      return c.json(full(t.notebookId));
    }),
  );

  // ── Un tema: sesión, fuentes, nota y tarjetas ────────────────────────
  const topicFull = (id: string) => {
    const t = topicOf(db, id);
    const note = t.noteId ? db.select().from(notes).where(and(eq(notes.id, t.noteId), isNull(notes.deletedAt))).get() : undefined;
    return {
      topic: topicOut(t),
      messages: messagesOf(db, t.id),
      sources: sourcesFor(db, t.notebookId, t.id),
      cards: db.select().from(nbCards).where(eq(nbCards.topicId, t.id)).orderBy(asc(nbCards.createdAt)).all().map((r) => cardOut(r)),
      note: note ? { id: note.id, title: noteTitle(note), markdown: bodyMarkdown(note) } : null,
    };
  };

  r.get('/topics/:id', guard((c) => c.json(topicFull(param(c, 'id')))));

  const noteBodiesFor = (nbProfile: string, sources: { noteId: string | null }[]) => {
    const ids = sources.map((s) => s.noteId).filter((x): x is string => !!x);
    if (!ids.length) return {};
    const rows = db.select().from(notes).where(and(eq(notes.profileId, nbProfile), inArray(notes.id, ids), isNull(notes.deletedAt))).all();
    return Object.fromEntries(rows.map((n) => [noteTitle(n), bodyMarkdown(n)]));
  };

  r.post(
    '/topics/:id/turn',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      const nb = notebookOf(db, t.notebookId);
      const body = z.object({ text: z.string().trim().max(8000).optional() }).safeParse((await json(c)) ?? {});
      if (!body.success) return c.json({ error: 'Respuesta no válida' }, 400);
      const said = body.data.text;
      if (said) addMessage(db, t.id, 'yo', said, t.stage);
      try {
        const sources = sourcesFor(db, nb.id, t.id);
        const out = await turn(ai, nb, topicsOf(db, nb.id), topicOf(db, t.id), sources, messagesOf(db, t.id), noteBodiesFor(nb.profileId, sources));
        addMessage(db, t.id, 'tutor', out.message, out.stage);
        db.update(nbTopics)
          .set({ stage: out.stage, gaps: JSON.stringify(out.gaps), solid: JSON.stringify(out.solid), status: t.status === 'pendiente' ? 'estudiando' : t.status, updatedAt: nowIso() })
          .where(eq(nbTopics.id, t.id))
          .run();
        touch(db, nb.id);
      } catch (e) {
        // Lo que escribió la persona no se pierde aunque la IA falle: se reintenta sin texto.
        return fail(c, e);
      }
      return c.json(topicFull(t.id));
    }),
  );

  // Fuentes: la IA las elige (y saca apuntes); la persona añade, fija o quita.
  const candidates = (profileId: string, query: string, taken: Set<string>): NoteCandidate[] => {
    const q = ftsAny(query);
    if (!q) return [];
    const rows = db
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(sql`notes_fts`, sql`notes_fts.rowid = ${notes}.rowid`)
      .where(and(eq(notes.profileId, profileId), isNull(notes.deletedAt), isNull(notes.archivedAt), sql`notes_fts MATCH ${q}`))
      .orderBy(sql`bm25(notes_fts, 4.0, 1.0)`)
      .limit(12)
      .all();
    const all = new Map(liveNotes(db, profileId).map((n) => [n.id, n]));
    return rows
      .map((r) => all.get(r.id))
      .filter((n): n is NonNullable<typeof n> => !!n && !taken.has(n.id) && n.kind === 'text')
      .slice(0, 8)
      .map((n) => ({ id: n.id, title: noteTitle(n), text: bodyMarkdown(n) }));
  };

  const autoSources = async (nbId: string, topicId: string | null) => {
    const nb = notebookOf(db, nbId);
    const topic = topicId ? topicOf(db, topicId) : null;
    const all = sourcesFor(db, nb.id, topicId, true);
    const keep = all.filter((s) => !s.removed);
    const removed = all.filter((s) => s.removed);
    const taken = new Set(all.map((s) => s.noteId).filter((x): x is string => !!x));
    const notesFound = candidates(nb.profileId, `${nb.title} ${topic?.title ?? ''} ${topic?.summary ?? ''}`, taken);
    const out = await findSources(ai, nb, topic, { keep, removed, notes: notesFound, search: nb.sourceMode === 'auto' });
    addSources(db, nb.id, topicId, out.sources, 'ia');
    addSources(
      db,
      nb.id,
      topicId,
      out.noteIds.map((id) => ({ kind: 'nota', title: notesFound.find((n) => n.id === id)!.title, noteId: id, why: 'De tu biblioteca' })),
      'ia',
    );
    if (topicId) db.update(nbTopics).set({ brief: out.brief.slice(0, 12000), updatedAt: nowIso() }).where(eq(nbTopics.id, topicId)).run();
  };

  r.post(
    '/topics/:id/sources/auto',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      await autoSources(t.notebookId, t.id);
      return c.json(topicFull(t.id));
    }),
  );

  const sourceBody = z.object({
    title: z.string().trim().max(300).optional(),
    url: z.string().trim().url().max(2000).optional(),
    noteId: z.string().max(40).optional(),
  });
  const addManual = async (c: Context, nbId: string, topicId: string | null) => {
    const body = sourceBody.safeParse(await json(c));
    if (!body.success || (!body.data.url && !body.data.noteId)) throw new NbError('Pega un enlace o elige una nota');
    const nb = notebookOf(db, nbId);
    let title = body.data.title;
    if (body.data.noteId) {
      const n = db.select().from(notes).where(and(eq(notes.id, body.data.noteId), eq(notes.profileId, nb.profileId), isNull(notes.deletedAt))).get();
      if (!n) throw new NbError('Nota no encontrada', 404);
      title ||= noteTitle(n);
    }
    if (!title && body.data.url) {
      const u = new URL(body.data.url);
      title = `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? decodeURIComponent(u.pathname).replace(/\/+$/, '') : ''}`.slice(0, 200);
    }
    addSources(db, nb.id, topicId, [{ title: title!, url: body.data.url ?? null, noteId: body.data.noteId ?? null }], 'manual');
  };
  r.post(
    '/notebooks/:id/sources',
    guard(async (c) => {
      const nb = notebookOf(db, param(c, 'id'));
      await addManual(c, nb.id, null);
      return c.json(full(nb.id), 201);
    }),
  );
  r.post(
    '/topics/:id/sources',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      await addManual(c, t.notebookId, t.id);
      return c.json(topicFull(t.id), 201);
    }),
  );
  r.patch(
    '/nb-sources/:id',
    guard(async (c) => {
      const s = db.select().from(nbSources).where(eq(nbSources.id, param(c, 'id'))).get();
      if (!s) throw new NbError('Fuente no encontrada', 404);
      const body = z.object({ pinned: z.boolean(), removed: z.boolean() }).partial().safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
      db.update(nbSources)
        .set({
          ...(body.data.pinned !== undefined ? { pinned: body.data.pinned ? 1 : 0 } : {}),
          ...(body.data.removed !== undefined ? { removed: body.data.removed ? 1 : 0, ...(body.data.removed ? { pinned: 0 } : {}) } : {}),
        })
        .where(eq(nbSources.id, s.id))
        .run();
      touch(db, s.notebookId);
      return c.json(s.topicId ? topicFull(s.topicId) : full(s.notebookId));
    }),
  );

  // Tu nota: es una nota normal de la biblioteca. Sin markdown, la primera vez
  // se crea vacía donde diga la persona (para escribirla en el editor de
  // siempre) y después la IA revisa lo que haya escrito en ella.
  r.post(
    '/topics/:id/note',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      const nb = notebookOf(db, t.notebookId);
      const body = z
        .object({ markdown: z.string().trim().min(1).max(60_000).optional(), title: z.string().trim().max(200).optional(), parentId: z.string().max(40).nullish(), review: z.boolean().optional() })
        .safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Escribe tu nota antes de guardarla' }, 400);
      const all = liveNotes(db, nb.profileId);
      // Dónde va: donde diga la persona, o en la carpeta del cuaderno (que se crea la primera vez).
      let parentId = body.data.parentId === undefined ? nb.folderId : body.data.parentId;
      if (parentId && !all.some((n) => n.id === parentId)) parentId = null;
      if (body.data.parentId === undefined && !parentId) {
        const folder = all.find((n) => !n.zoneId && !n.archivedAt && n.kind === 'text' && (n.title ?? '').trim().toLocaleLowerCase() === nb.title.trim().toLocaleLowerCase()) ?? createNote(db, nb.profileId, { doc: newDoc(nb.title, ''), parentId: null });
        parentId = folder.id;
        db.update(notebooks).set({ folderId: folder.id }).where(eq(notebooks.id, nb.id)).run();
      }
      const title = body.data.title || t.title;
      const existing = t.noteId ? all.find((n) => n.id === t.noteId) : undefined;
      let note;
      let markdown = body.data.markdown;
      if (existing && markdown !== undefined) {
        note = saveNote(db, existing.id, contentOf(editDoc(existing, { title, content: markdown })));
      } else if (existing) {
        note = existing;
        markdown = bodyMarkdown(existing).trim();
      } else {
        note = createNote(db, nb.profileId, { doc: newDoc(title, markdown ?? ''), parentId: parentId ?? null });
        db.update(nbTopics).set({ noteId: note.id, updatedAt: nowIso() }).where(eq(nbTopics.id, t.id)).run();
      }
      if (note !== existing) libraryChanged(c);
      if (body.data.review === false || (!existing && markdown === undefined)) return c.json({ ...topicFull(t.id), review: null });
      if (!markdown) return c.json({ error: 'Tu nota está vacía: escríbela antes de que Claude la revise' }, 400);
      try {
        const library = liveNotes(db, nb.profileId)
          .filter((n) => n.id !== note.id && !n.archivedAt && n.kind === 'text' && n.title?.trim())
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((n) => noteTitle(n));
        const review = await reviewNote(ai, nb, topicOf(db, t.id), messagesOf(db, t.id), markdown, library);
        db.update(nbTopics).set({ lesson: review.lesson.slice(0, 40_000), updatedAt: nowIso() }).where(eq(nbTopics.id, t.id)).run();
        const byTitle = new Map(liveNotes(db, nb.profileId).map((n) => [noteTitle(n), n.id]));
        return c.json({ ...topicFull(t.id), review: { ...review, links: review.links.map((title) => ({ title, id: byTitle.get(title) ?? null })) } });
      } catch (e) {
        if (e instanceof AiError) return c.json({ ...topicFull(t.id), review: null, reviewError: e.message });
        throw e;
      }
    }),
  );

  // Conectar la nota con otra de la biblioteca (lo que propone la revisión).
  r.post(
    '/topics/:id/link',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      const nb = notebookOf(db, t.notebookId);
      const body = z.object({ noteId: z.string().max(40) }).safeParse(await json(c));
      if (!body.success || !t.noteId) return c.json({ error: 'Primero guarda tu nota' }, 400);
      const all = liveNotes(db, nb.profileId);
      const mine = all.find((n) => n.id === t.noteId);
      const other = all.find((n) => n.id === body.data.noteId);
      if (!mine || !other) return c.json({ error: 'Nota no encontrada' }, 404);
      // Un [[enlace]] al final de su nota, como los que se escriben a mano.
      if (!bodyMarkdown(mine).includes(`[[${noteTitle(other)}]]`)) saveNote(db, mine.id, contentOf(editDoc(mine, { append: `Relacionada: [[${noteTitle(other)}]]` })));
      connect(db, nb.profileId, mine.id, other.id);
      libraryChanged(c);
      return c.json(topicFull(t.id));
    }),
  );

  const cardsBody = z.object({
    cards: z.array(z.object({ kind: z.enum(['dato', 'explica', 'problema']).optional(), front: z.string().max(2000), back: z.string().max(4000) })).max(50),
    finish: z.boolean().optional(),
  });
  r.post(
    '/topics/:id/cards',
    guard(async (c) => {
      const t = topicOf(db, param(c, 'id'));
      const body = cardsBody.safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Tarjetas no válidas' }, 400);
      addCards(db, t.notebookId, t.id, body.data.cards);
      if (body.data.finish) db.update(nbTopics).set({ status: 'hecho', stage: 'fin', updatedAt: nowIso() }).where(eq(nbTopics.id, t.id)).run();
      return c.json(topicFull(t.id), 201);
    }),
  );

  // ── Repaso ──────────────────────────────────────────────────────────
  r.get('/profiles/:pid/review', (c) => {
    const only = c.req.query('notebook');
    const nbs = db.select().from(notebooks).where(eq(notebooks.profileId, param(c, 'pid'))).all().filter((n) => !only || n.id === only);
    const titles = new Map(nbs.map((n) => [n.id, n.title]));
    const due = dueCards(db, nbs.map((n) => n.id));
    const topicIds = [...new Set(due.map((d) => d.topicId).filter((x): x is string => !!x))];
    const topicTitles = new Map(topicIds.length ? db.select({ id: nbTopics.id, title: nbTopics.title }).from(nbTopics).where(inArray(nbTopics.id, topicIds)).all().map((x) => [x.id, x.title]) : []);
    return c.json(due.map((d) => cardOut(d, { notebook: titles.get(d.notebookId) ?? '', topic: d.topicId ? (topicTitles.get(d.topicId) ?? null) : null, next: preview(d) })));
  });

  r.post(
    '/nb-cards/:id/grade',
    guard(async (c) => {
      const body = z
        .object({ rating: z.number().int().min(1).max(4), confidence: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(95)]).nullish(), answer: z.string().max(4000).nullish() })
        .safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Nota no válida' }, 400);
      const saved = grade(db, param(c, 'id'), body.data.rating, body.data);
      return c.json(cardOut(saved));
    }),
  );
  r.patch(
    '/nb-cards/:id',
    guard(async (c) => {
      const body = z.object({ front: z.string().trim().min(1).max(2000), back: z.string().trim().min(1).max(4000) }).partial().safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
      const row = db.update(nbCards).set(body.data).where(eq(nbCards.id, param(c, 'id'))).returning().get();
      if (!row) throw new NbError('Tarjeta no encontrada', 404);
      return c.json(cardOut(row));
    }),
  );
  r.delete('/nb-cards/:id', (c) => {
    const res = db.delete(nbCards).where(eq(nbCards.id, param(c, 'id'))).run();
    return res.changes ? c.body(null, 204) : c.json({ error: 'Tarjeta no encontrada' }, 404);
  });

  // Qué notas de la biblioteca salieron de un cuaderno (para su enlace de vuelta).
  r.get('/profiles/:pid/notebook-links', (c) => {
    const rows = db
      .select({ noteId: nbTopics.noteId, topicId: nbTopics.id, topic: nbTopics.title, notebookId: notebooks.id, notebook: notebooks.title })
      .from(nbTopics)
      .innerJoin(notebooks, eq(notebooks.id, nbTopics.notebookId))
      .where(and(eq(notebooks.profileId, param(c, 'pid')), sql`${nbTopics.noteId} is not null`))
      .all();
    return c.json(rows);
  });

  return r;
}
