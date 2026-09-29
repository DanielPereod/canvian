import { Hono } from 'hono';
import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// Preferencias de la interfaz: los atajos de teclado, el aspecto (modo y temas) y los experimentos del laboratorio. Viven en la
// tabla de ajustes con el prefijo `pref:`, que nunca deja ver lo demás (la
// contraseña está en la misma tabla).

const PREFIX = 'pref:';
const KEYS = ['keymap', 'theme', 'experiments', 'appearance'] as const;
const keymap = z.record(z.string().regex(/^[a-z][a-zA-Z]{1,30}$/), z.string().max(40)).refine((m) => Object.keys(m).length <= 100);
const theme = z.enum(['jardin', 'papel', 'observatorio', 'bloques', 'piedras', 'plano', 'minimo', 'minimo-claro', 'biblioteca', 'biblioteca-noche']);
// Modo claro, oscuro o automático, y el tema de cada tono.
const appearance = z.object({ mode: z.enum(['light', 'dark', 'auto']), dark: theme, light: theme });
const experiments = z.record(z.string().regex(/^[a-z][a-zA-Z]{1,30}$/), z.boolean()).refine((m) => Object.keys(m).length <= 50);
const SCHEMAS: Record<(typeof KEYS)[number], z.ZodType> = { keymap, theme, experiments, appearance };

export function prefRoutes(db: Db) {
  const r = new Hono();

  r.get('/prefs', (c) => {
    const rows = db.select().from(settings).where(like(settings.key, `${PREFIX}%`)).all();
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.slice(PREFIX.length);
      if (!(KEYS as readonly string[]).includes(key)) continue;
      try {
        out[key] = JSON.parse(row.value);
      } catch {
        // Un valor roto se ignora: vuelven los de fábrica.
      }
    }
    return c.json(out);
  });

  r.put('/prefs/:key', async (c) => {
    const key = c.req.param('key') as (typeof KEYS)[number];
    if (!KEYS.includes(key)) return c.json({ error: 'Preferencia desconocida' }, 404);
    const body = SCHEMAS[key].safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Valor no válido' }, 400);
    const value = JSON.stringify(body.data);
    db.insert(settings)
      .values({ key: PREFIX + key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
    return c.body(null, 204);
  });

  r.delete('/prefs/:key', (c) => {
    db.delete(settings).where(eq(settings.key, PREFIX + c.req.param('key'))).run();
    return c.body(null, 204);
  });

  return r;
}
