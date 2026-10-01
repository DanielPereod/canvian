import { Hono } from 'hono';
import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// Preferencias de la interfaz: los atajos de teclado, el aspecto (modo, temas y letra), la barra lateral las notas en modo ancho, el idioma y los calendarios de fuera. Viven en la
// tabla de ajustes con el prefijo `pref:`, que nunca deja ver lo demás (la
// contraseña está en la misma tabla).

const PREFIX = 'pref:';
const KEYS = ['keymap', 'theme', 'appearance', 'type', 'sidebar', 'wide', 'lang', 'calendars'] as const;
const keymap = z.record(z.string().regex(/^[a-z][a-zA-Z]{1,30}$/), z.string().max(40)).refine((m) => Object.keys(m).length <= 100);
const theme = z.enum(['jardin', 'papel', 'observatorio', 'bloques', 'piedras', 'plano', 'minimo', 'minimo-claro', 'biblioteca', 'biblioteca-noche']);
// Modo claro, oscuro o automático, y el tema de cada tono.
const appearance = z.object({ mode: z.enum(['light', 'dark', 'auto']), dark: theme, light: theme });
// Letras de la interfaz, los títulos, el texto y el código (un id del catálogo
// de la web, «tema» o «ui») y tamaño base.
const font = z.string().regex(/^[a-z0-9-]{1,40}$/);
const type = z.object({ ui: font, titles: font, text: font, code: font, size: z.number().int().min(12).max(18) });
// Barra lateral: el orden de las hijas de cada nota y el color de cada una.
const id = z.string().min(1).max(40);
const sidebar = z.object({
  order: z.record(id, z.array(id).max(2000)).refine((m) => Object.keys(m).length <= 2000),
  colors: z.record(id, z.string().regex(/^#[0-9a-f]{6}$/i)).refine((m) => Object.keys(m).length <= 5000),
});
// Las notas que se leen en modo ancho.
const wide = z.array(id).max(5000);
// Idioma de la interfaz.
const lang = z.enum(['es', 'en']);
// Calendarios de fuera por su enlace iCal, cada uno con su color y encendido o no.
const calendars = z
  .array(
    z.object({
      id,
      name: z.string().trim().min(1).max(80),
      url: z.string().trim().regex(/^(https?|webcals?):\/\//i).max(2000),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      on: z.boolean(),
    }),
  )
  .max(30);
const SCHEMAS: Record<(typeof KEYS)[number], z.ZodType> = { keymap, theme, appearance, type, sidebar, wide, lang, calendars };

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
