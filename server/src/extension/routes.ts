import { Hono, type Context } from 'hono';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, or } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { mailLinks, settings } from '../db/schema.js';
import { newBlockId } from '../doc/json.js';
import { allTasks, changeTask, listedTasks, newTaskItem, taskBlockIds, withTaskBlockId, type Task, type TaskStatus } from '../doc/tasks.js';
import type { LiveEvent } from '../live.js';
import { localDay } from '../mcp/server.js';
import {
  INBOX,
  McpError,
  contentOf,
  createNote,
  descendantIds,
  linkWikis,
  listProfiles,
  liveNotes,
  newDoc,
  noteTitle,
  parseProps,
  pathOf,
  propertyFor,
  coerceProp,
  resolveProfile,
  saveNote,
  withTags,
  type Note,
} from '../mcp/notes.js';
import { findTask, insertTask } from '../mcp/taskops.js';
import { mcpStatus } from '../mcp/token.js';
import { zip } from '../koreader/plugin.js';

// La extensión de Canvian para el navegador (carpeta extension/ del repo):
//  · el recortador guarda una página o lo seleccionado como nota, en la
//    carpeta que se elija (como Obsidian Web Clipper);
//  · en Outlook, cada hilo de correo enseña las tareas vinculadas a él, con su
//    estado, y deja crear otras o vincular las que ya hay.
// Habla con «Authorization: Bearer <llave>»; la llave se crea en
// Configuración › Extensión del navegador.

type Hub = { publish: (e: LiveEvent) => void };

const TOKEN = 'extension_token';
/** Donde van los recortes si no se elige carpeta (como «Clippings» en Obsidian). */
export const CLIPS = 'Recortes';

const get = (db: Db, key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const extensionToken = (db: Db) => get(db, TOKEN);

export function createExtensionToken(db: Db): string {
  const token = randomBytes(24).toString('base64url');
  db.insert(settings).values({ key: TOKEN, value: token }).onConflictDoUpdate({ target: settings.key, set: { value: token } }).run();
  return token;
}

export const revokeExtensionToken = (db: Db) => db.delete(settings).where(eq(settings.key, TOKEN)).run();

export function isExtensionToken(db: Db, token: string | null | undefined): boolean {
  const saved = extensionToken(db);
  return !!token && !!saved && timingSafeEqual(sha256(token), sha256(saved));
}

/**
 * El asunto de un hilo sin «RE:», «RV:», «FW:»… ni «[EXTERNAL]», en minúsculas
 * y sin tildes: así una respuesta encuentra las tareas del hilo aunque Outlook
 * le dé otro id.
 */
export function subjectKey(subject: string | null | undefined): string | null {
  let s = (subject ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const prefix = /^\s*(?:\[[^\]]{1,30}\]\s*)?(?:re|rv|fw|fwd|tr|aw|wg|sv|vs|res|enc|r)\s*(?:\[\d+\])?\s*:\s*/i;
  for (let i = 0; i < 10 && prefix.test(s); i++) s = s.replace(prefix, '');
  s = s.replace(/^\s*\[[^\]]{1,30}\]\s*/, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

// La carpeta extension/ del repositorio (igual desde src/ que desde dist/).
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'extension');

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? filesIn(full) : [full];
  });
}

/**
 * La extensión en un .zip, con la dirección y la llave ya puestas (config.js)
 * y permiso para esa dirección en el manifest, para «Cargar descomprimida».
 */
export function extensionZip(url: string, token: string): Buffer | null {
  if (!existsSync(join(SOURCE, 'manifest.json'))) return null;
  const files = filesIn(SOURCE)
    .map((full) => relative(SOURCE, full).split('\\').join('/'))
    .filter((name) => !name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => {
      let data = readFileSync(join(SOURCE, name));
      if (name === 'config.js') data = Buffer.from(`// Generado por Canvian (Configuración › Extensión del navegador).\nexport const PRESET = ${JSON.stringify({ url, token })};\n`);
      if (name === 'manifest.json') {
        const manifest = JSON.parse(data.toString()) as { host_permissions?: string[] };
        manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), `${new URL(url).origin}/*`])];
        data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      }
      return { name: `canvian-extension/${name}`, data };
    });
  return zip(files);
}

// Settings (con sesión): la llave, la dirección con la que se llega y la descarga.
export function extensionSettingsRoutes(db: Db) {
  const r = new Hono();
  r.get('/extension', (c) => c.json({ token: extensionToken(db), publicUrl: mcpStatus(db).publicUrl }));
  r.get('/extension/download.zip', (c) => {
    const base = (c.req.query('base') ?? '').trim().replace(/\/+$/, '');
    const url = mcpStatus(db).publicUrl || (/^https?:\/\/[^\s/]+/.test(base) ? base : new URL(c.req.url).origin);
    const token = extensionToken(db) ?? createExtensionToken(db);
    const data = extensionZip(url, token);
    if (!data) return c.json({ error: 'Este servidor no tiene la extensión' }, 404);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="canvian-extension.zip"',
      'Cache-Control': 'no-store',
    });
  });
  r.post('/extension/token', (c) => c.json({ token: createExtensionToken(db) }, 201));
  r.delete('/extension/token', (c) => {
    revokeExtensionToken(db);
    return c.body(null, 204);
  });
  return r;
}

const STATUS = ['todo', 'doing', 'blocked', 'done'] as const;
const PRIORITY = { none: 0, low: 1, medium: 2, high: 3 } as const;
const priorityName = (p: number) => (['none', 'low', 'medium', 'high'] as const)[p] ?? 'none';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const clipBody = z.object({
  profile: z.string().optional(),
  parent: z.string().nullish(),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(500_000).default(''),
  url: z.string().url().max(2000).nullish(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  // Propiedades sueltas (Autor, Publicado…), con su nombre.
  properties: z.record(z.string().trim().min(1).max(60), z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200))])).optional(),
});

const threadArgs = {
  profile: z.string().optional(),
  thread: z.string().trim().min(1).max(500),
  subject: z.string().max(500).nullish(),
  url: z.string().max(2000).nullish(),
};
const linkBody = z.object({ ...threadArgs, task: z.string().min(3).max(200) });
const newTaskBody = z.object({
  ...threadArgs,
  text: z.string().trim().min(1).max(1000),
  due: day.nullish(),
  priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
  note: z.string().nullish(),
});
const taskPatch = z.object({ profile: z.string().optional(), task: z.string().min(3).max(200), status: z.enum(STATUS) });

export function extensionRoutes(db: Db, hub?: Hub) {
  const r = new Hono();
  const changed = () => hub?.publish({ scope: 'canvas', client: 'extension' });

  r.use('*', async (c, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
    if (!isExtensionToken(db, token)) return c.json({ error: 'Llave de la extensión no válida' }, 401);
    await next();
  });

  // Errores esperables (una nota que no está…) como 400 con su mensaje.
  const safe = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof McpError) return c.json({ error: e.message }, 400);
      throw e;
    }
  };
  const json = async (c: Context) => c.req.json().catch(() => null);

  const ctx = (profile?: string | null) => {
    const p = resolveProfile(db, profile);
    const all = liveNotes(db, p.id);
    return { profile: p, all, byId: new Map(all.map((n) => [n.id, n])) };
  };
  const hidden = (all: Note[]) => {
    const out = new Set<string>();
    for (const n of all) if (n.archivedAt) {
      out.add(n.id);
      for (const d of descendantIds(all, n.id)) out.add(d);
    }
    return out;
  };
  const base = (c: Context) => mcpStatus(db).publicUrl || new URL(c.req.url).origin;
  // La web abre la nota (y salta a la casilla) con #nota/<perfil>/<nota>[/<bloque>].
  const openUrl = (c: Context, profileId: string, noteId: string, blockId?: string | null) =>
    `${base(c)}/#nota/${profileId}/${noteId}${blockId ? `/${blockId}` : ''}`;

  // La tarea con su id de bloque; si no lo tenía, se le pone (y se guarda la nota).
  const anchor = (profileId: string, byId: Map<string, Note>, t: Task): string => {
    const row = byId.get(t.noteId)!;
    const had = taskBlockIds(row)[t.n];
    if (had) return had;
    const id = newBlockId();
    const doc = withTaskBlockId(row, t.n, id);
    if (!doc) throw new McpError('Esa tarea ya no está en su nota.');
    byId.set(row.id, saveNote(db, row.id, contentOf(doc)));
    return id;
  };
  const taskOut = (c: Context, profileId: string, byId: Map<string, Note>, t: Task, blockId?: string | null) => {
    const note = byId.get(t.noteId);
    return {
      id: t.id,
      text: t.title,
      status: t.status,
      ...(t.dueAt ? { due: t.dueAt } : {}),
      ...(t.startAt ? { start: t.startAt } : {}),
      ...(t.priority ? { priority: priorityName(t.priority) } : {}),
      ...(t.tags.length ? { tags: t.tags } : {}),
      ...(t.repeat ? { repeat: t.repeat } : {}),
      ...(t.doneAt ? { done: t.doneAt } : {}),
      note: { id: t.noteId, title: note ? noteTitle(note) : '', path: note ? pathOf(byId, note) : '' },
      open: openUrl(c, profileId, t.noteId, blockId ?? taskBlockIds(note!)[t.n]),
    };
  };
  // Las tareas vinculadas a un hilo: por su id o por su asunto.
  const threadLinks = (profileId: string, thread: string, subject?: string | null) => {
    const key = subjectKey(subject);
    return db
      .select()
      .from(mailLinks)
      .where(and(eq(mailLinks.profileId, profileId), key ? or(eq(mailLinks.thread, thread), eq(mailLinks.subjectKey, key)) : eq(mailLinks.thread, thread)))
      .all();
  };
  const threadTasks = (c: Context, profileId: string, byId: Map<string, Note>, thread: string, subject?: string | null) => {
    const seen = new Set<string>();
    const out = [];
    for (const l of threadLinks(profileId, thread, subject).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const key = `${l.noteId}^${l.blockId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const note = byId.get(l.noteId);
      const n = note ? taskBlockIds(note).indexOf(l.blockId) : -1;
      const t = n >= 0 ? allTasks([note!])[n] : undefined;
      // La casilla se borró (o perdió su id): se enseña para poder quitar el vínculo.
      if (!t) out.push({ linkId: l.id, missing: true, note: note ? { id: note.id, title: noteTitle(note), path: pathOf(byId, note) } : null });
      else out.push({ linkId: l.id, ...taskOut(c, profileId, byId, t, l.blockId) });
    }
    return out;
  };
  const link = (profileId: string, args: { thread: string; subject?: string | null; url?: string | null }, noteId: string, blockId: string) => {
    db.insert(mailLinks)
      .values({ id: ulid(), profileId, thread: args.thread, subject: args.subject?.trim() || null, subjectKey: subjectKey(args.subject), url: args.url || null, noteId, blockId })
      .onConflictDoNothing()
      .run();
  };

  r.get('/profiles', (c) => c.json({ profiles: listProfiles(db).map((p) => ({ id: p.id, name: p.name, color: p.color })), publicUrl: base(c) }));

  // Las notas de texto donde se puede guardar un recorte o una tarea, con su ruta.
  r.get(
    '/folders',
    safe((c) => {
      const { all, byId } = ctx(c.req.query('profile'));
      const off = hidden(all);
      const folders = all
        .filter((n) => n.kind === 'text' && !off.has(n.id))
        .map((n) => ({ id: n.id, title: noteTitle(n), path: pathOf(byId, n), updated: n.updatedAt }))
        .sort((a, b) => a.path.localeCompare(b.path, 'es'));
      return c.json({ folders, clips: CLIPS, inbox: INBOX });
    }),
  );

  // Guarda un recorte como nota nueva (por defecto, dentro de «Recortes»).
  r.post(
    '/clip',
    safe(async (c) => {
      const body = clipBody.safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Recorte no válido' }, 400);
      const { profile: p, all, byId } = ctx(body.data.profile);
      const { title, markdown, url, tags, properties } = body.data;
      let parent: Note | null = null;
      if (body.data.parent) {
        parent = byId.get(body.data.parent) ?? null;
        if (!parent) throw new McpError('La carpeta ya no existe.');
      } else {
        parent = all.find((n) => !n.zoneId && n.kind === 'text' && !n.archivedAt && noteTitle(n).toLocaleLowerCase('es') === CLIPS.toLocaleLowerCase('es')) ?? null;
        if (!parent) {
          parent = createNote(db, p.id, { doc: newDoc(CLIPS, ''), parentId: null });
          byId.set(parent.id, parent);
        }
      }
      const doc = newDoc(title, markdown);
      let props: Record<string, unknown> = tags?.length ? withTags(db, p.id, null, tags) : {};
      const named: Record<string, unknown> = { ...(url ? { Fuente: url } : {}), ...properties };
      for (const [name, value] of Object.entries(named)) {
        const def = propertyFor(db, p.id, name, value);
        const v = def ? coerceProp(db, def, value) : null;
        if (def && v !== null) props = { ...props, [def.id]: v };
      }
      let row = createNote(db, p.id, { doc, parentId: parent.id, props: Object.keys(props).length ? props : undefined });
      const links = linkWikis(db, p.id, row.id, doc);
      if (links.linked.length) row = saveNote(db, row.id, contentOf(doc));
      byId.set(row.id, row);
      changed();
      return c.json({ id: row.id, title: noteTitle(row), path: pathOf(byId, row), props: parseProps(row.props), open: openUrl(c, p.id, row.id) }, 201);
    }),
  );

  // Tareas sin hacer, para vincular una a un hilo (filtradas por texto).
  r.get(
    '/tasks',
    safe((c) => {
      const { profile: p, all, byId } = ctx(c.req.query('profile'));
      const off = hidden(all);
      const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      const words = fold(c.req.query('q') ?? '').split(/\s+/).filter(Boolean);
      const limit = Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 200);
      const tasks = listedTasks(all.filter((n) => !off.has(n.id)))
        .filter((t) => t.status !== 'done')
        .filter((t) => {
          const hay = fold(`${t.title} ${t.tags.join(' ')} ${noteTitle(byId.get(t.noteId)!)}`);
          return words.every((w) => hay.includes(w));
        })
        .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || b.priority - a.priority);
      return c.json({ today: localDay(), tasks: tasks.slice(0, limit).map((t) => taskOut(c, p.id, byId, t)) });
    }),
  );

  // Las tareas de un hilo de correo.
  r.get(
    '/thread',
    safe((c) => {
      const thread = c.req.query('thread')?.trim();
      if (!thread) return c.json({ error: 'Falta el hilo' }, 400);
      const { profile: p, byId } = ctx(c.req.query('profile'));
      return c.json({ today: localDay(), tasks: threadTasks(c, p.id, byId, thread, c.req.query('subject')) });
    }),
  );

  // Vincula una tarea que ya existe al hilo.
  r.post(
    '/thread/link',
    safe(async (c) => {
      const body = linkBody.safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Datos no válidos' }, 400);
      const { profile: p, all, byId } = ctx(body.data.profile);
      const t = findTask(all, body.data.task);
      const blockId = anchor(p.id, byId, t);
      link(p.id, body.data, t.noteId, blockId);
      changed();
      return c.json({ today: localDay(), tasks: threadTasks(c, p.id, byId, body.data.thread, body.data.subject) });
    }),
  );

  // Crea una tarea (en la nota elegida o en «Tareas») y la vincula al hilo.
  r.post(
    '/thread/task',
    safe(async (c) => {
      const body = newTaskBody.safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Tarea no válida' }, 400);
      const { profile: p, all, byId } = ctx(body.data.profile);
      const { text, due, priority, note } = body.data;
      let host: Note | undefined;
      if (note) {
        host = byId.get(note);
        if (!host || host.kind !== 'text') throw new McpError('Esa nota no admite tareas.');
      }
      const blockId = newBlockId();
      const item = newTaskItem(text, { dueAt: due ?? null, priority: priority ? PRIORITY[priority] : 0 });
      item.attrs = { ...item.attrs, blockId };
      const { row } = insertTask(db, p.id, all, item, { host });
      byId.set(row.id, row);
      link(p.id, body.data, row.id, blockId);
      changed();
      return c.json({ today: localDay(), tasks: threadTasks(c, p.id, byId, body.data.thread, body.data.subject) }, 201);
    }),
  );

  // Cambia el estado de una tarea (hecha, en curso…) desde el correo.
  r.patch(
    '/task',
    safe(async (c) => {
      const body = taskPatch.safeParse(await json(c));
      if (!body.success) return c.json({ error: 'Datos no válidos' }, 400);
      const { profile: p, all, byId } = ctx(body.data.profile);
      const t = findTask(all, body.data.task);
      const row = byId.get(t.noteId)!;
      const doc = changeTask(row, t, { status: body.data.status as TaskStatus });
      if (!doc) throw new McpError('Esa tarea ya no está en su nota.');
      linkWikis(db, p.id, row.id, doc);
      const saved = saveNote(db, row.id, contentOf(doc));
      byId.set(saved.id, saved);
      changed();
      return c.json({ ok: true });
    }),
  );

  // Quita un vínculo (la tarea sigue en su nota).
  r.delete('/link/:id', (c) => {
    const res = db.delete(mailLinks).where(eq(mailLinks.id, c.req.param('id'))).run();
    return res.changes ? c.body(null, 204) : c.json({ error: 'Vínculo no encontrado' }, 404);
  });

  return r;
}
