import { Hono } from 'hono';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { lenses, profiles } from '../db/schema.js';

// Modo de una lente: atenuar, ocultar u ordenar en columnas (con su criterio, p. ej. "arrange:status").
const mode = z.string().regex(/^(dim|hide|arrange(:[\w-]{1,40})?)$/);
const slot = z.number().int().min(1).max(9).nullable();
const lensCreate = z.object({
  id: z.string().min(10).max(40).optional(),
  name: z.string().trim().min(1).max(80),
  query: z.string().trim().min(1).max(500),
  mode: mode.default('dim'),
  slot: slot.optional(),
});
const lensPatch = z.object({ name: z.string().trim().min(1).max(80), query: z.string().trim().min(1).max(500), mode, slot }).partial();

const json = async (req: { json: () => Promise<unknown> }) => req.json().catch(() => null);

// Lentes guardadas: filtros con nombre que se abren con ⇧1…⇧9.
export function lensRoutes(db: Db) {
  const r = new Hono();

  const freeSlot = (profileId: string) => {
    const used = new Set(
      db
        .select({ slot: lenses.slot })
        .from(lenses)
        .where(and(eq(lenses.profileId, profileId), isNotNull(lenses.slot)))
        .all()
        .map((l) => l.slot),
    );
    for (let s = 1; s <= 9; s++) if (!used.has(s)) return s;
    return null;
  };

  // Un atajo solo puede tener una lente: quien lo tuviera se queda sin él.
  const takeSlot = (profileId: string, s: number | null | undefined, except?: string) => {
    if (!s) return;
    const holder = db.select().from(lenses).where(and(eq(lenses.profileId, profileId), eq(lenses.slot, s))).get();
    if (holder && holder.id !== except) db.update(lenses).set({ slot: null }).where(eq(lenses.id, holder.id)).run();
  };

  r.get('/profiles/:id/lenses', (c) =>
    c.json(db.select().from(lenses).where(eq(lenses.profileId, c.req.param('id'))).orderBy(asc(lenses.slot), asc(lenses.name)).all()),
  );

  r.post('/profiles/:id/lenses', async (c) => {
    const profileId = c.req.param('id');
    if (!db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, profileId)).get())
      return c.json({ error: 'Perfil no encontrado' }, 404);
    const body = lensCreate.safeParse(await json(c.req));
    if (!body.success) return c.json({ error: 'Lente no válida' }, 400);
    const { id, slot: wanted, ...rest } = body.data;
    const s = wanted === undefined ? freeSlot(profileId) : wanted;
    takeSlot(profileId, s);
    const row = db.insert(lenses).values({ id: id ?? ulid(), profileId, ...rest, slot: s }).returning().get();
    return c.json(row, 201);
  });

  r.patch('/lenses/:id', async (c) => {
    const body = lensPatch.safeParse(await json(c.req));
    if (!body.success || !Object.keys(body.data).length) return c.json({ error: 'Cambios no válidos' }, 400);
    const lens = db.select().from(lenses).where(eq(lenses.id, c.req.param('id'))).get();
    if (!lens) return c.json({ error: 'Lente no encontrada' }, 404);
    takeSlot(lens.profileId, body.data.slot, lens.id);
    return c.json(db.update(lenses).set(body.data).where(eq(lenses.id, lens.id)).returning().get());
  });

  r.delete('/lenses/:id', (c) => {
    const res = db.delete(lenses).where(eq(lenses.id, c.req.param('id'))).run();
    return res.changes ? c.body(null, 204) : c.json({ error: 'Lente no encontrada' }, 404);
  });

  return r;
}
