import { Hono } from 'hono';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { notes, profiles, propertyDefs } from '../db/schema.js';

export const PROPERTY_TYPES = ['text', 'number', 'select', 'tags', 'date', 'checkbox', 'url'] as const;

// Hay quien tiene cientos de etiquetas: el tope solo evita listas absurdas.
const options = z.array(z.string().trim().min(1).max(60)).max(5000);
const propertyCreate = z.object({
  id: z.string().min(10).max(40).optional(),
  name: z.string().trim().min(1).max(60),
  type: z.enum(PROPERTY_TYPES),
  options: options.optional(),
});
const propertyPatch = z
  .object({ name: z.string().trim().min(1).max(60), options, position: z.number().int() })
  .partial();

const json = async (req: { json: () => Promise<unknown> }) => req.json().catch(() => null);

// Propiedades personalizadas de cada perfil. Las notas guardan sus valores en
// `props` usando el id de la propiedad como clave, así renombrarla no pierde nada.
const toClient = (row: typeof propertyDefs.$inferSelect) => ({ ...row, options: JSON.parse(row.options) as string[] });

export function propertyRoutes(db: Db) {
  const r = new Hono();

  r.get('/profiles/:id/properties', (c) =>
    c.json(
      db
        .select()
        .from(propertyDefs)
        .where(eq(propertyDefs.profileId, c.req.param('id')))
        .orderBy(asc(propertyDefs.position))
        .all()
        .map(toClient),
    ),
  );

  r.post('/profiles/:id/properties', async (c) => {
    const profileId = c.req.param('id');
    if (!db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, profileId)).get())
      return c.json({ error: 'Perfil no encontrado' }, 404);
    const body = propertyCreate.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Propiedad no válida' }, 400);
    const { id, name, type } = body.data;
    const taken = db
      .select({ id: propertyDefs.id })
      .from(propertyDefs)
      .where(and(eq(propertyDefs.profileId, profileId), sql`lower(${propertyDefs.name}) = lower(${name})`))
      .get();
    if (taken) return c.json({ error: 'Ya hay una propiedad con ese nombre' }, 409);
    const last = db.select({ p: max(propertyDefs.position) }).from(propertyDefs).where(eq(propertyDefs.profileId, profileId)).get();
    const row = db
      .insert(propertyDefs)
      .values({
        id: id ?? ulid(),
        profileId,
        name,
        type,
        options: JSON.stringify(body.data.options ?? []),
        appliesTo: 'all',
        position: (last?.p ?? -1) + 1,
      })
      .returning()
      .get();
    return c.json(toClient(row), 201);
  });

  r.patch('/properties/:id', async (c) => {
    const body = propertyPatch.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
    const { options: opts, ...rest } = body.data;
    const set = { ...rest, ...(opts ? { options: JSON.stringify(opts) } : {}) };
    if (!Object.keys(set).length) return c.json({ error: 'Nada que cambiar' }, 400);
    try {
      const row = db.update(propertyDefs).set(set).where(eq(propertyDefs.id, c.req.param('id'))).returning().get();
      return row ? c.json(toClient(row)) : c.json({ error: 'Propiedad no encontrada' }, 404);
    } catch {
      return c.json({ error: 'Ya hay una propiedad con ese nombre' }, 409);
    }
  });

  // Borrar una propiedad también borra su valor en todas las notas del perfil.
  r.delete('/properties/:id', (c) => {
    const id = c.req.param('id');
    const def = db.select().from(propertyDefs).where(eq(propertyDefs.id, id)).get();
    if (!def) return c.json({ error: 'Propiedad no encontrada' }, 404);
    db.transaction((tx) => {
      tx.delete(propertyDefs).where(eq(propertyDefs.id, id)).run();
      tx.update(notes)
        .set({ props: sql`json_remove(${notes.props}, ${`$."${id}"`})` })
        .where(and(eq(notes.profileId, def.profileId), sql`json_type(${notes.props}, ${`$."${id}"`}) is not null`))
        .run();
    });
    return c.body(null, 204);
  });

  return r;
}
