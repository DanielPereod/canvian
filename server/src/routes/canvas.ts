import { Hono } from 'hono';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { edges, notes, profiles } from '../db/schema.js';

// Las tareas no son notas: son las casillas «- [ ]» de su texto.
const KINDS = ['text', 'canvas', 'link', 'image', 'checklist', 'code'] as const;

const noteFields = {
  kind: z.enum(KINDS),
  title: z.string().max(500).nullable(),
  bodyJson: z.string().max(1_000_000).nullable(),
  bodyText: z.string().max(200_000).nullable(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive().nullable(),
  h: z.number().positive().nullable(),
  z: z.number().int(),
  zoneId: z.string().nullable(),
  priority: z.number().int().min(0).max(3).nullable(),
  dueAt: z.string().max(40).nullable(),
  archivedAt: z.string().max(40).nullable(),
  // Valores de las propiedades personalizadas, por id de propiedad.
  props: z
    .record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.array(z.string().min(1).max(60)).max(40)]))
    .refine((p) => Object.keys(p).length <= 100)
    .transform((p) => JSON.stringify(p)),
};

const noteCreate = z
  .object(noteFields)
  .partial()
  .required({ x: true, y: true })
  .extend({ id: z.string().min(10).max(40).optional() });
const notePatch = z.object(noteFields).partial();
const layoutPatch = z
  .array(
    z.object({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      w: z.number().positive().nullish(),
      h: z.number().positive().nullish(),
      zoneId: z.string().nullish(),
    }),
  )
  .max(2000);
const edgeCreate = z.object({
  id: z.string().min(10).max(40).optional(),
  fromId: z.string(),
  toId: z.string(),
  label: z.string().max(200).nullish(),
});
const edgePatch = z.object({ label: z.string().max(200).nullable() });

const nowIso = () => new Date().toISOString();
const json = async (req: { json: () => Promise<unknown> }) => req.json().catch(() => null);

// Convierte lo que escribes en ⌘K en una consulta FTS5 segura: cada palabra
// entre comillas y con prefijo, para que "presu" encuentre "presupuesto".
export function toFtsQuery(input: string): string | null {
  const terms = input
    .normalize('NFKC')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `"${t}"*`).join(' ') : null;
}

export function canvasRoutes(db: Db) {
  const r = new Hono();

  const profileExists = (id: string) =>
    db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).get() !== undefined;
  const liveNote = (id: string) =>
    db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
      .get();

  r.get('/profiles/:id/canvas', (c) => {
    const profileId = c.req.param('id');
    if (!profileExists(profileId)) return c.json({ error: 'Perfil no encontrado' }, 404);
    return c.json({
      notes: db
        .select()
        .from(notes)
        .where(and(eq(notes.profileId, profileId), isNull(notes.deletedAt)))
        .all(),
      edges: db.select().from(edges).where(eq(edges.profileId, profileId)).all(),
    });
  });

  r.post('/profiles/:id/notes', async (c) => {
    const profileId = c.req.param('id');
    if (!profileExists(profileId)) return c.json({ error: 'Perfil no encontrado' }, 404);
    const body = noteCreate.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Nota no válida' }, 400);
    const { id, ...values } = body.data;
    const row = db
      .insert(notes)
      .values({ kind: 'text', ...values, id: id ?? ulid(), profileId })
      .returning()
      .get();
    return c.json(row, 201);
  });

  // Guarda posiciones y tamaños de varias notas a la vez (mover una zona mueve su contenido).
  r.patch('/notes/layout', async (c) => {
    const body = layoutPatch.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Posiciones no válidas' }, 400);
    const updatedAt = nowIso();
    db.transaction((tx) => {
      for (const { id, ...pos } of body.data) {
        const set = Object.fromEntries(Object.entries(pos).filter(([, v]) => v !== undefined));
        tx.update(notes).set({ ...set, updatedAt }).where(eq(notes.id, id)).run();
      }
    });
    return c.body(null, 204);
  });

  r.patch('/notes/:id', async (c) => {
    const body = notePatch.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
    const row = db
      .update(notes)
      .set({ ...body.data, updatedAt: nowIso() })
      .where(and(eq(notes.id, c.req.param('id')), isNull(notes.deletedAt)))
      .returning()
      .get();
    return row ? c.json(row) : c.json({ error: 'Nota no encontrada' }, 404);
  });

  // Borrado suave: la nota va a la papelera y sus enlaces desaparecen.
  r.delete('/notes/:id', (c) => {
    const id = c.req.param('id');
    const note = liveNote(id);
    if (!note) return c.json({ error: 'Nota no encontrada' }, 404);
    db.transaction((tx) => {
      tx.update(notes).set({ deletedAt: nowIso() }).where(eq(notes.id, id)).run();
      tx.delete(edges).where(or(eq(edges.fromId, id), eq(edges.toId, id))).run();
      // Las hijas de una nota borrada pasan a su madre.
      tx.update(notes).set({ zoneId: note.zoneId }).where(eq(notes.zoneId, id)).run();
    });
    return c.body(null, 204);
  });

  r.post('/profiles/:id/edges', async (c) => {
    const profileId = c.req.param('id');
    const body = edgeCreate.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Enlace no válido' }, 400);
    const { id, fromId, toId, label } = body.data;
    if (fromId === toId) return c.json({ error: 'Una nota no se puede enlazar consigo misma' }, 400);
    const ends = db
      .select({ id: notes.id })
      .from(notes)
      .where(and(inArray(notes.id, [fromId, toId]), eq(notes.profileId, profileId), isNull(notes.deletedAt)))
      .all();
    if (ends.length !== 2) return c.json({ error: 'Las notas no existen en este perfil' }, 404);
    const existing = db
      .select()
      .from(edges)
      .where(
        or(
          and(eq(edges.fromId, fromId), eq(edges.toId, toId)),
          and(eq(edges.fromId, toId), eq(edges.toId, fromId)),
        ),
      )
      .get();
    if (existing) return c.json(existing);
    const row = db
      .insert(edges)
      .values({ id: id ?? ulid(), profileId, fromId, toId, label: label ?? null })
      .returning()
      .get();
    return c.json(row, 201);
  });

  r.patch('/edges/:id', async (c) => {
    const body = edgePatch.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Etiqueta no válida' }, 400);
    const row = db.update(edges).set(body.data).where(eq(edges.id, c.req.param('id'))).returning().get();
    return row ? c.json(row) : c.json({ error: 'Enlace no encontrado' }, 404);
  });

  r.delete('/edges/:id', (c) => {
    const res = db.delete(edges).where(eq(edges.id, c.req.param('id'))).run();
    return res.changes ? c.body(null, 204) : c.json({ error: 'Enlace no encontrado' }, 404);
  });

  r.get('/profiles/:id/search', (c) => {
    const profileId = c.req.param('id');
    const q = toFtsQuery(c.req.query('q') ?? '');
    const base = and(eq(notes.profileId, profileId), isNull(notes.deletedAt));
    const columns = { id: notes.id, title: notes.title, bodyText: notes.bodyText, kind: notes.kind };
    if (!q) {
      return c.json(db.select(columns).from(notes).where(base).orderBy(sql`${notes.updatedAt} desc`).limit(12).all());
    }
    const rows = db
      .select(columns)
      .from(notes)
      .innerJoin(sql`notes_fts`, sql`notes_fts.rowid = ${notes}.rowid`)
      .where(and(base, sql`notes_fts MATCH ${q}`))
      .orderBy(sql`bm25(notes_fts, 4.0, 1.0)`)
      .limit(20)
      .all();
    return c.json(rows);
  });

  return r;
}
