import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { and, eq, isNull } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { notes, profiles, settings, shares } from '../db/schema.js';
import { sendMedia } from './media.js';

// Notas públicas. Desde la app (con sesión) se crea, cambia o quita el enlace
// de una nota; desde fuera (sin sesión), quien tenga el enlace la lee, después
// de escribir la contraseña si la tiene. Solo se ve lo que se compartió: la
// nota, y de sus hijas ninguna, todas o las elegidas.

export type ShareScope = 'note' | 'all' | 'some';

const shareBody = z.object({
  scope: z.enum(['note', 'all', 'some']),
  childIds: z.array(z.string().min(1).max(40)).max(2000).default([]),
  // Sin poner: se queda la que hubiera. null: sin contraseña.
  password: z.string().min(4).max(200).nullable().optional(),
});
const unlockBody = z.object({ password: z.string().min(1).max(200) });

const COOKIE = 'canvian_share_';
const COOKIE_DAYS = 30;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
// Lo que lleva la cookie de quien ya escribió la contraseña. Sale del hash de
// la contraseña, así que al cambiarla (o quitarla y volver a ponerla) hay que
// escribir la nueva.
const passOf = (slug: string, passwordHash: string) => sha256(`${slug}:${passwordHash}`);

type ShareRow = typeof shares.$inferSelect;
type NoteRow = typeof notes.$inferSelect;

const view = (s: ShareRow) => ({
  id: s.id,
  noteId: s.noteId,
  scope: s.scope as ShareScope,
  childIds: parseIds(s.childIds),
  hasPassword: !!s.passwordHash,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Las notas que se ven con este enlace: la compartida y, bajando por sus
// hijas, las que entran (una hija solo entra si su madre también).
export function sharedNotes(db: Db, share: ShareRow): NoteRow[] {
  const root = db
    .select()
    .from(notes)
    .where(and(eq(notes.id, share.noteId), isNull(notes.deletedAt), isNull(notes.archivedAt)))
    .get();
  if (!root) return [];
  const out = [root];
  if (share.scope === 'note') return out;
  const picked = new Set(parseIds(share.childIds));
  const all = db
    .select()
    .from(notes)
    .where(and(eq(notes.profileId, root.profileId), isNull(notes.deletedAt), isNull(notes.archivedAt)))
    .all();
  const kids = new Map<string, NoteRow[]>();
  for (const n of all) {
    if (!n.zoneId) continue;
    const list = kids.get(n.zoneId);
    if (list) list.push(n);
    else kids.set(n.zoneId, [n]);
  }
  const seen = new Set([root.id]);
  for (let i = 0; i < out.length && out.length < 5000; i++) {
    for (const k of kids.get(out[i].id) ?? []) {
      if (seen.has(k.id) || (share.scope === 'some' && !picked.has(k.id))) continue;
      seen.add(k.id);
      out.push(k);
    }
  }
  return out;
}

// El aspecto con el que se ve: el del perfil de la nota, o el general.
function lookOf(db: Db, profileId: string) {
  const pref = (key: string) => {
    const row = db.select().from(settings).where(eq(settings.key, `pref:${key}`)).get();
    try {
      return row ? JSON.parse(row.value) : null;
    } catch {
      return null;
    }
  };
  const own = pref('profileThemes')?.[profileId] ?? null;
  const profile = db.select({ color: profiles.color }).from(profiles).where(eq(profiles.id, profileId)).get();
  return { appearance: own ?? pref('appearance'), type: pref('type'), accent: profile?.color ?? null };
}

// Los archivos de las notas se piden por su ruta pública, que comprueba el enlace.
const MEDIA = /\/api\/media\/([0-9A-HJKMNP-TV-Z]{26}\.[a-z0-9]{1,10})/g;
const publicMedia = (slug: string, s: string | null) => s && s.replace(MEDIA, `/api/public/${slug}/media/$1`);

// Pocos intentos de contraseña por enlace: argon2 ya es lento, pero así no se
// puede probar sin parar.
const TRIES = 10;
const WINDOW_MS = 5 * 60 * 1000;

export function shareRoutes(db: Db) {
  const r = new Hono();

  const liveNote = (id: string) =>
    db
      .select({ id: notes.id, profileId: notes.profileId })
      .from(notes)
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
      .get();
  const shareOf = (noteId: string) => db.select().from(shares).where(eq(shares.noteId, noteId)).get();

  r.get('/profiles/:id/shares', (c) => {
    const rows = db
      .select({ share: shares })
      .from(shares)
      .innerJoin(notes, eq(notes.id, shares.noteId))
      .where(and(eq(notes.profileId, c.req.param('id')), isNull(notes.deletedAt)))
      .all();
    return c.json(rows.map((r) => view(r.share)));
  });

  r.get('/notes/:id/share', (c) => {
    const id = c.req.param('id');
    if (!liveNote(id)) return c.json({ error: 'Nota no encontrada' }, 404);
    const row = shareOf(id);
    return c.json(row ? view(row) : null);
  });

  r.put('/notes/:id/share', async (c) => {
    const id = c.req.param('id');
    if (!liveNote(id)) return c.json({ error: 'Nota no encontrada' }, 404);
    const body = shareBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const short = body.error.issues.some((i) => i.path[0] === 'password');
      return c.json({ error: short ? 'La contraseña necesita al menos 4 caracteres' : 'Datos no válidos' }, 400);
    }
    const { scope, childIds, password } = body.data;
    const set: Partial<ShareRow> = {
      scope,
      childIds: JSON.stringify(scope === 'some' ? [...new Set(childIds)] : []),
      updatedAt: new Date().toISOString(),
    };
    if (password !== undefined) set.passwordHash = password === null ? null : await hash(password);
    const before = shareOf(id);
    const row = before
      ? db.update(shares).set(set).where(eq(shares.id, before.id)).returning().get()
      : db
          .insert(shares)
          .values({ ...set, id: randomBytes(12).toString('base64url'), noteId: id, scope })
          .returning()
          .get();
    return c.json(view(row), before ? 200 : 201);
  });

  r.delete('/notes/:id/share', (c) => {
    db.delete(shares).where(eq(shares.noteId, c.req.param('id'))).run();
    return c.body(null, 204);
  });

  return r;
}

// Lo que se ve sin sesión, en /api/public/<enlace>.
export function publicRoutes(db: Db, mediaDir?: string) {
  const r = new Hono();
  const tries = new Map<string, { n: number; until: number }>();

  const find = (slug: string) => db.select().from(shares).where(eq(shares.id, slug)).get();
  const unlocked = (c: Context, s: ShareRow) => {
    if (!s.passwordHash) return true;
    const got = getCookie(c, COOKIE + s.id);
    const want = passOf(s.id, s.passwordHash);
    return !!got && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  };
  const gone = (c: Context) => c.json({ error: 'Este enlace no existe o ya no se comparte' }, 404);

  r.use('*', async (c, next) => {
    await next();
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Referrer-Policy', 'no-referrer');
  });

  r.get('/:slug', (c) => {
    const slug = c.req.param('slug');
    const s = find(slug);
    const list = s ? sharedNotes(db, s) : [];
    if (!s || !list.length) return gone(c);
    if (!unlocked(c, s)) return c.json({ error: 'Esta nota tiene contraseña', locked: true }, 401);
    const ids = new Set(list.map((n) => n.id));
    return c.json({
      id: s.id,
      rootId: s.noteId,
      look: lookOf(db, list[0].profileId),
      notes: list.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        // La madre solo si también se ve; la compartida va arriba del todo.
        parentId: n.id !== s.noteId && n.zoneId && ids.has(n.zoneId) ? n.zoneId : null,
        bodyJson: publicMedia(slug, n.bodyJson),
        cover: publicMedia(slug, n.cover),
        updatedAt: n.updatedAt,
      })),
    });
  });

  r.post('/:slug/unlock', async (c) => {
    const slug = c.req.param('slug');
    const s = find(slug);
    if (!s || !sharedNotes(db, s).length) return gone(c);
    if (!s.passwordHash) return c.json({ ok: true });
    const now = Date.now();
    const t = tries.get(slug);
    if (t && t.until > now && t.n >= TRIES) return c.json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' }, 429);
    const body = unlockBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !(await verify(s.passwordHash, body.data.password))) {
      tries.set(slug, t && t.until > now ? { n: t.n + 1, until: t.until } : { n: 1, until: now + WINDOW_MS });
      return c.json({ error: 'Contraseña incorrecta' }, 401);
    }
    tries.delete(slug);
    const https = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
    setCookie(c, COOKIE + s.id, passOf(s.id, s.passwordHash), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: https,
      path: `/api/public/${s.id}`,
      maxAge: COOKIE_DAYS * 24 * 60 * 60,
    });
    return c.json({ ok: true });
  });

  // Solo los archivos que salen en lo que se comparte.
  r.get('/:slug/media/:name', (c) => {
    const s = find(c.req.param('slug'));
    const name = c.req.param('name');
    if (!s || !mediaDir) return gone(c);
    if (!unlocked(c, s)) return c.json({ error: 'Esta nota tiene contraseña', locked: true }, 401);
    const needle = `/api/media/${name}`;
    const used = sharedNotes(db, s).some((n) => n.bodyJson?.includes(needle) || n.cover?.includes(needle));
    if (!used) return c.json({ error: 'No encontrado' }, 404);
    return sendMedia(c, mediaDir, name, 'private, max-age=3600');
  });

  return r;
}
