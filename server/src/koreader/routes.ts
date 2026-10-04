import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { LiveEvent } from '../live.js';
import { McpError, listProfiles, liveNotes } from '../mcp/notes.js';
import { mcpStatus } from '../mcp/token.js';
import { pluginZip } from './plugin.js';
import {
  KoreaderError,
  createKoreaderToken,
  isKoreaderToken,
  koreaderFolder,
  koreaderToken,
  revokeKoreaderToken,
  setKoreaderFolder,
  syncBody,
  syncBook,
} from './sync.js';

type Hub = { publish: (e: LiveEvent) => void };

// Configuración › KOReader (con sesión): la llave, la carpeta de cada perfil y
// la descarga del plugin ya configurado.
export function koreaderSettingsRoutes(db: Db) {
  const r = new Hono();

  const status = () => ({
    token: koreaderToken(db),
    publicUrl: mcpStatus(db).publicUrl,
    folders: Object.fromEntries(listProfiles(db).map((p) => [p.id, koreaderFolder(db, p.id)])),
  });

  r.get('/koreader', (c) => c.json(status()));
  r.post('/koreader/token', (c) => c.json({ token: createKoreaderToken(db) }, 201));
  r.delete('/koreader/token', (c) => {
    revokeKoreaderToken(db);
    return c.body(null, 204);
  });

  r.put('/koreader/folder', async (c) => {
    const body = z.object({ profileId: z.string().min(1), noteId: z.string().min(1).nullable() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Datos no válidos' }, 400);
    const { profileId, noteId } = body.data;
    if (!listProfiles(db).some((p) => p.id === profileId)) return c.json({ error: 'Perfil no encontrado' }, 404);
    if (noteId && !liveNotes(db, profileId).some((n) => n.id === noteId)) return c.json({ error: 'Nota no encontrada' }, 404);
    setKoreaderFolder(db, profileId, noteId);
    return c.json(status());
  });

  // El .zip del plugin con la dirección, la llave y el perfil ya puestos.
  r.get('/koreader/plugin.zip', (c) => {
    const base = (c.req.query('base') ?? '').trim().replace(/\/+$/, '');
    const url = mcpStatus(db).publicUrl || (/^https?:\/\/[^\s/]+/.test(base) ? base : new URL(c.req.url).origin);
    const profile = listProfiles(db).find((p) => p.id === c.req.query('profile')) ?? listProfiles(db)[0] ?? null;
    const token = koreaderToken(db) ?? createKoreaderToken(db);
    const zip = pluginZip({ url, token, profile: profile?.id ?? null, profileName: profile?.name ?? null, lang: c.req.query('lang') === 'en' ? 'en' : 'es' });
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="canvian.koplugin.zip"',
      'Cache-Control': 'no-store',
    });
  });

  return r;
}

// Lo que llama el plugin, con «Authorization: Bearer <llave>».
export function koreaderRoutes(db: Db, hub?: Hub) {
  const r = new Hono();

  r.use('*', async (c, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
    if (!isKoreaderToken(db, token)) return c.json({ error: 'Llave de KOReader no válida' }, 401);
    await next();
  });

  r.get('/profiles', (c) => c.json({ profiles: listProfiles(db).map((p) => ({ id: p.id, name: p.name })) }));

  r.post('/sync', async (c) => {
    const body = syncBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Datos del libro no válidos' }, 400);
    try {
      const result = syncBook(db, body.data);
      if ('id' in result && result.changed) hub?.publish({ scope: 'canvas', client: 'koreader' });
      return c.json(result);
    } catch (e) {
      if (e instanceof McpError || e instanceof KoreaderError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  return r;
}
