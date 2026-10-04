import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
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
import { canvasRoutes } from './routes/canvas.js';
import { propertyRoutes } from './routes/properties.js';
import { lensRoutes } from './routes/lenses.js';
import { mediaRoutes } from './routes/media.js';
import { prefRoutes } from './routes/prefs.js';
import { calendarRoutes } from './routes/calendars.js';
import { unfurlRoutes } from './routes/unfurl.js';
import type { Fetcher } from './calendars.js';
import { createHub, scopeOf } from './live.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './mcp/server.js';
import { createMcpToken, isMcpToken, mcpStatus, revokeMcpToken, setMcpPublicUrl } from './mcp/token.js';

const passwordBody = z.object({ password: z.string().min(8).max(200) });
const loginBody = z.object({ password: z.string().min(1).max(200) });
const profileBody = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().max(20).nullish(),
  icon: z.string().max(40).nullish(),
});
const profilePatch = profileBody.partial().extend({ position: z.number().int().optional() });
const viewportBody = z.object({ x: z.number(), y: z.number(), zoom: z.number().positive() });

// Mismos valores que --hue-* en web/src/design/tokens.css.
const PROFILE_COLORS = ['#4FD1C5', '#F0B45A', '#F28B82', '#7CB8F2', '#B9A3F0', '#9DC88D'];

const DEFAULT_PROFILES = [
  { name: 'Personal', color: PROFILE_COLORS[0], icon: 'home' },
  { name: 'Trabajo', color: PROFILE_COLORS[1], icon: 'briefcase' },
];

export function createApp(db: Db, opts: { mediaDir?: string; heartbeatMs?: number; fetchCalendar?: Fetcher; fetchPage?: Fetcher } = {}) {
  const api = new Hono();
  const hub = createHub();

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

  // Cada escritura que sale bien se anuncia a los demás dispositivos.
  api.use('*', async (c, next) => {
    await next();
    const scope = scopeOf(c.req.method, c.req.path);
    if (scope && c.res.status < 400) hub.publish({ scope, client: c.req.header('x-canvian-client') ?? null });
  });

  // Canal de avisos (Server-Sent Events). El latido mantiene viva la conexión
  // a través de proxies que cortan las que llevan un rato en silencio.
  api.get('/events', (c) => {
    const res = streamSSE(c, async (stream) => {
      const stop = hub.listen((e) => {
        void stream.writeSSE({ event: 'change', data: JSON.stringify(e) });
      });
      const beat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), opts.heartbeatMs ?? 15_000);
      // Un comentario largo al principio: algunos proxies no sueltan nada hasta llenar su búfer.
      await stream.write(`:${' '.repeat(2048)}\n\n`);
      await stream.writeSSE({ event: 'hello', data: '' });
      await new Promise<void>((done) => stream.onAbort(done));
      clearInterval(beat);
      stop();
    });
    // Que ningún proxy (nginx, Cloudflare…) guarde los avisos para mandarlos juntos.
    res.headers.set('Cache-Control', 'no-cache, no-transform');
    res.headers.set('X-Accel-Buffering', 'no');
    return res;
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
      .values({ id: ulid(), ...body.data, color: body.data.color ?? PROFILE_COLORS[position % PROFILE_COLORS.length], position })
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

  // La llave del MCP (Configuración › Asistentes IA).
  api.get('/mcp', (c) => c.json(mcpStatus(db)));
  api.post('/mcp/token', (c) => {
    if (mcpStatus(db).fromEnv) return c.json({ error: 'La llave viene de CANVIAN_MCP_TOKEN' }, 409);
    return c.json({ token: createMcpToken(db) }, 201);
  });
  // La dirección con la que se llega desde fuera (https://…), para los enlaces.
  api.put('/mcp/public-url', async (c) => {
    const body = z.object({ url: z.string().trim().regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/).max(300).nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Dirección no válida' }, 400);
    setMcpPublicUrl(db, body.data.url?.replace(/\/+$/, '') || null);
    return c.json(mcpStatus(db));
  });
  api.delete('/mcp/token', (c) => {
    revokeMcpToken(db);
    return c.body(null, 204);
  });

  api.route('/', canvasRoutes(db));
  api.route('/', propertyRoutes(db));
  api.route('/', lensRoutes(db));
  api.route('/', prefRoutes(db));
  api.route('/', calendarRoutes(db, opts.fetchCalendar));
  api.route('/', unfurlRoutes(opts.fetchPage));
  if (opts.mediaDir) api.route('/', mediaRoutes(opts.mediaDir));

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));

  // El servidor MCP (Streamable HTTP, sin estado). La llave va en la ruta
  // (/mcp/<llave>, para los conectores de claude.ai, que no dejan poner
  // cabeceras) o como «Authorization: Bearer <llave>».
  const mcp = async (c: Context, token: string | undefined) => {
    if (!isMcpToken(db, token)) return c.json({ error: 'Llave del MCP no válida' }, 401);
    // Sin sesiones no hay canal de avisos (GET) ni sesión que cerrar (DELETE).
    if (c.req.method !== 'POST') return c.json({ error: 'Solo POST' }, 405, { Allow: 'POST' });
    const server = createMcpServer(db, hub);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  // Sin OAuth: que los clientes MCP no tomen la web por sus metadatos.
  app.all('/.well-known/*', (c) => c.json({ error: 'No encontrado' }, 404));
  app.all('/mcp', (c) => mcp(c, /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim()));
  app.all('/mcp/:token', (c) => mcp(c, c.req.param('token')));
  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'No encontrado' }, 404));
  return app;
}
