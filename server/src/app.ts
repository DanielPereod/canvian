import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { asc, count, eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { profiles, viewports } from './db/schema.js';
import {
  SESSION_COOKIE,
  checkPassword,
  createSession,
  deleteSession,
  isSetupDone,
  isValidSession,
  setPassword,
} from './auth.js';

const passwordBody = z.object({ password: z.string().min(8).max(200) });
const loginBody = z.object({ password: z.string().min(1).max(200) });
const profileBody = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().max(20).nullish(),
  icon: z.string().max(40).nullish(),
});
const profilePatch = profileBody.partial().extend({ position: z.number().int().optional() });
const viewportBody = z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() });

const DEFAULT_PROFILES = [
  { name: 'Personal', color: '#4FD1C5', icon: 'home' },
  { name: 'Trabajo', color: '#F0B45A', icon: 'briefcase' },
];

export function createApp(db: Db) {
  const api = new Hono();

  // La cookie solo se marca Secure si llega por HTTPS (directo o tras un proxy);
  // en la red local por http://192.168.x.x tiene que funcionar sin ella.
  const startSession = (c: Context) => {
    const { token, expiresAt } = createSession(db);
    const https =
      new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: https,
      path: '/',
      expires: expiresAt,
    });
  };

  api.get('/auth/status', (c) =>
    c.json({
      setupDone: isSetupDone(db),
      authenticated: isValidSession(db, getCookie(c, SESSION_COOKIE)),
    }),
  );

  api.post('/auth/setup', async (c) => {
    if (isSetupDone(db)) return c.json({ error: 'La contraseña ya está configurada' }, 409);
    const body = passwordBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'La contraseña necesita al menos 8 caracteres' }, 400);
    await setPassword(db, body.data.password);
    if (db.select({ n: count() }).from(profiles).get()!.n === 0) {
      db.insert(profiles)
        .values(DEFAULT_PROFILES.map((p, position) => ({ ...p, id: ulid(), position })))
        .run();
    }
    startSession(c);
    return c.json({ ok: true });
  });

  api.post('/auth/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !(await checkPassword(db, body.data.password))) {
      return c.json({ error: 'Contraseña incorrecta' }, 401);
    }
    startSession(c);
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c) => {
    deleteSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Todo lo que viene después requiere sesión.
  api.use('*', async (c, next) => {
    if (!isValidSession(db, getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: 'Sesión no válida' }, 401);
    }
    await next();
  });

  api.get('/profiles', (c) =>
    c.json(db.select().from(profiles).orderBy(asc(profiles.position), asc(profiles.createdAt)).all()),
  );

  api.post('/profiles', async (c) => {
    const body = profileBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Datos de perfil no válidos' }, 400);
    const position = db.select({ n: count() }).from(profiles).get()!.n;
    const row = db
      .insert(profiles)
      .values({ id: ulid(), ...body.data, position })
      .returning()
      .get();
    return c.json(row, 201);
  });

  api.patch('/profiles/:id', async (c) => {
    const body = profilePatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Datos de perfil no válidos' }, 400);
    const row = db
      .update(profiles)
      .set(body.data)
      .where(eq(profiles.id, c.req.param('id')))
      .returning()
      .get();
    return row ? c.json(row) : c.json({ error: 'Perfil no encontrado' }, 404);
  });

  api.delete('/profiles/:id', (c) => {
    if (db.select({ n: count() }).from(profiles).get()!.n <= 1) {
      return c.json({ error: 'Tiene que quedar al menos un perfil' }, 409);
    }
    const res = db.delete(profiles).where(eq(profiles.id, c.req.param('id'))).run();
    return res.changes ? c.body(null, 204) : c.json({ error: 'Perfil no encontrado' }, 404);
  });

  api.get('/profiles/:id/viewport', (c) => {
    const row = db.select().from(viewports).where(eq(viewports.profileId, c.req.param('id'))).get();
    return c.json(row ?? { profileId: c.req.param('id'), x: 0, y: 0, zoom: 1 });
  });

  api.put('/profiles/:id/viewport', async (c) => {
    const body = viewportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Vista no válida' }, 400);
    const profileId = c.req.param('id');
    if (!db.select().from(profiles).where(eq(profiles.id, profileId)).get()) {
      return c.json({ error: 'Perfil no encontrado' }, 404);
    }
    db.insert(viewports)
      .values({ profileId, ...body.data })
      .onConflictDoUpdate({ target: viewports.profileId, set: body.data })
      .run();
    return c.body(null, 204);
  });

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'No encontrado' }, 404));
  return app;
}
