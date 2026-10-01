import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { createCalendarCache, eventsBetween, normalizeUrl, type CalEvent, type Fetcher } from '../calendars.js';

// Eventos de los calendarios de fuera que estén encendidos (la lista vive en la
// preferencia `calendars`), entre dos días. Se pide un día de más por cada lado
// porque el servidor no sabe en qué zona horaria está quien mira.

type Calendar = { id: string; name: string; url: string; color: string; on: boolean };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

export function calendarRoutes(db: Db, fetcher?: Fetcher) {
  const r = new Hono();
  const cache = createCalendarCache(fetcher);

  const calendars = (): Calendar[] => {
    const row = db.select().from(settings).where(eq(settings.key, 'pref:calendars')).get();
    try {
      const v = row ? JSON.parse(row.value) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  r.get('/calendars/events', async (c) => {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    if (!DAY.test(from) || !DAY.test(to)) return c.json({ error: 'Periodo no válido' }, 400);
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (!(days > 0 && days <= MAX_DAYS)) return c.json({ error: 'Periodo no válido' }, 400);
    start.setUTCDate(start.getUTCDate() - 1);
    end.setUTCDate(end.getUTCDate() + 1);

    const fresh = c.req.query('fresh') === '1';
    const list = calendars();
    cache.keep(list.map((k) => normalizeUrl(k.url)).filter((u): u is string => !!u));
    const events: CalEvent[] = [];
    const errors: Record<string, string> = {};
    await Promise.all(
      list
        .filter((k) => k.on)
        .map(async (k) => {
          const url = normalizeUrl(k.url);
          if (!url) return void (errors[k.id] = 'Enlace no válido');
          const entry = await cache.get(url, fresh);
          if (entry.error) errors[k.id] = entry.error;
          if (!entry.comp) return;
          try {
            events.push(...eventsBetween(entry.comp, k.id, start, end));
          } catch {
            errors[k.id] = 'No se ha podido leer el calendario';
          }
        }),
    );
    events.sort((a, b) => a.start.localeCompare(b.start));
    return c.json({ events, errors });
  });

  return r;
}
