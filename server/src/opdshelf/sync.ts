import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { parseBody, type JSONContent } from '../doc/json.js';
import { BOOK_KEY, COVER_KEY, OPDSHELF_KEY, SECTION, folderFor, mergeHighlights, setBookCover } from '../koreader/sync.js';
import { coerceProp, contentOf, createNote, liveNotes, newDoc, parseProps, propertyFor, resolveProfile, saveNote } from '../mcp/notes.js';
import { storeImage } from '../routes/media.js';

// Sincronización con opdshelf (el servidor de libros de Dani, que ya junta los
// subrayados de KOReader, la app de Android y el lector web). Aquí es Canvian
// quien pide: lee la API de opdshelf y guarda una nota por libro, en la misma
// carpeta y con la misma huella (el partial MD5 de KOReader) que usa el plugin
// de KOReader, así que las notas de libro que ya había siguen siendo las mismas.
// A diferencia del plugin, cada subrayado llega con su id de opdshelf, que se
// guarda como «^id» del bloque: un enlace [[Libro#^op-…]] sigue apuntando al
// mismo subrayado aunque se vuelva a sincronizar.

const CONFIG = 'opdshelf';
const STATE = 'opdshelf_state';
const TIMEOUT = 20_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export class OpdshelfError extends Error {}

// ── La conexión ───────────────────────────────────────────────────────

export const configBody = z.object({
  url: z.string().trim().regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/).max(300),
  /** Llave de API de opdshelf (Authorization: Bearer). Si la hay, se usa antes que el usuario. */
  key: z.string().trim().max(300).nullish(),
  username: z.string().trim().max(200).nullish(),
  password: z.string().max(500).nullish(),
  profileId: z.string().max(100).nullish(),
});
export type OpdshelfConfig = { url: string; key: string | null; username: string | null; password: string | null; profileId: string | null };

type State = { lastSync: string | null; lastError: string | null; books: number; seen: Record<string, number> };

const get = (db: Db, key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const put = (db: Db, key: string, value: string) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
const drop = (db: Db, key: string) => db.delete(settings).where(eq(settings.key, key)).run();
const json = <T>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const opdshelfConfig = (db: Db): OpdshelfConfig | null => json<OpdshelfConfig | null>(get(db, CONFIG), null);

/** Guarda la conexión. Lo que no venga (la contraseña o la llave) se queda como estaba. */
export function setOpdshelfConfig(db: Db, body: z.infer<typeof configBody>): OpdshelfConfig {
  const old = opdshelfConfig(db);
  const keep = <K extends 'key' | 'password'>(k: K) => (body[k] === undefined ? (old?.[k] ?? null) : body[k] || null);
  const config: OpdshelfConfig = {
    url: body.url.replace(/\/+$/, ''),
    key: keep('key'),
    username: body.username || null,
    password: keep('password'),
    profileId: body.profileId || null,
  };
  put(db, CONFIG, JSON.stringify(config));
  // Otro servidor, otros libros: se vuelve a mirar todo.
  if (old?.url !== config.url) drop(db, STATE);
  return config;
}

export function clearOpdshelf(db: Db) {
  drop(db, CONFIG);
  drop(db, STATE);
}

const readState = (db: Db): State => ({ lastSync: null, lastError: null, books: 0, seen: {}, ...json<Partial<State>>(get(db, STATE), {}) });
const writeState = (db: Db, s: State) => put(db, STATE, JSON.stringify(s));

/** Lo que enseña Configuración: nunca la contraseña ni la llave, solo si las hay. */
export function opdshelfStatus(db: Db) {
  const c = opdshelfConfig(db);
  const s = readState(db);
  return {
    config: c ? { url: c.url, username: c.username, profileId: c.profileId, hasKey: !!c.key, hasPassword: !!c.password } : null,
    lastSync: s.lastSync,
    lastError: s.lastError,
    books: s.books,
  };
}

function headers(c: OpdshelfConfig): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (c.key) h.authorization = `Bearer ${c.key}`;
  else if (c.username && c.password) h.authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
  return h;
}

async function call(fetcher: Fetcher, c: OpdshelfConfig, path: string, accept?: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetcher(c.url + path, { signal: ctrl.signal, headers: { ...headers(c), ...(accept ? { accept } : {}) } });
    if (res.status === 401) throw new OpdshelfError('opdshelf no acepta el usuario, la contraseña o la llave');
    if (res.status === 403) throw new OpdshelfError('La llave de opdshelf no deja leer esto');
    return res;
  } catch (e) {
    if (e instanceof OpdshelfError) throw e;
    throw new OpdshelfError(`No se pudo conectar con opdshelf (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(fetcher: Fetcher, c: OpdshelfConfig, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await call(fetcher, c, path);
  if (!res.ok) throw new OpdshelfError(`opdshelf respondió ${res.status} en ${path.split('?')[0]}`);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new OpdshelfError(`opdshelf respondió algo inesperado en ${path.split('?')[0]}`);
  return parsed.data;
}

// ── Lo que da opdshelf ────────────────────────────────────────────────

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().catch(null);

const bookRow = z.object({
  document: z.string().min(1).max(200),
  updated: z.number().catch(0),
  highlights: z.number().catch(0),
  path: opt(z.string()),
  title: opt(z.string()),
  // Solo si opdshelf ya los da en /api/annotations (si no, se sacan de /api/highlights).
  authors: opt(z.string()),
  cover: opt(z.string()),
});
const bookList = z.object({ books: z.array(bookRow) });

export const annotation = z.object({
  id: z.string().min(1).max(64),
  text: opt(z.string()),
  note: opt(z.string()),
  color: opt(z.string()),
  chapter: opt(z.string()),
  page: opt(z.number()),
  percentage: opt(z.number()),
  created: opt(z.number()),
  updated: opt(z.number()),
  deleted: opt(z.boolean()),
});
export type Annotation = z.infer<typeof annotation>;
const annotationList = z.object({ annotations: z.array(annotation) });
const highlightList = z.object({ highlights: z.array(z.object({ document: z.string(), authors: opt(z.string()) }).passthrough()) }).or(z.array(z.object({ document: z.string(), authors: opt(z.string()) }).passthrough()));

// ── La nota del libro ─────────────────────────────────────────────────

/** El id de opdshelf como id de bloque de Canvian (solo letras, cifras y guiones). */
export const blockIdOf = (id: string) => `op-${id.replace(/[^A-Za-z0-9-]/g, '-')}`;

const COLORS: Record<string, string> = {
  yellow: '🟡',
  orange: '🟠',
  red: '🔴',
  purple: '🟣',
  blue: '🔵',
  cyan: '🩵',
  green: '🟢',
  olive: '🫒',
  gray: '⚪',
};

const txt = (text: string): JSONContent => ({ type: 'text', text });
const paragraphs = (text: string): JSONContent[] =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ type: 'paragraph', content: [txt(l)] }));
const day = (secs: number | null | undefined) => (secs ? new Date(secs * 1000).toISOString().slice(0, 10) : null);
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Los subrayados como bloques, por capítulos: la cita lleva el «^id» de opdshelf;
 * debajo, la nota y una línea con el color, la página, el día y el enlace al lector.
 */
export function highlightBlocks(list: Annotation[], reader: string | null): JSONContent[] {
  const out: JSONContent[] = [{ type: 'heading', attrs: { level: 2 }, content: [txt(SECTION)] }];
  let chapter: string | null = null;
  for (const a of list) {
    if (a.deleted) continue;
    const quote = a.text ? paragraphs(a.text) : [];
    const note = a.note ? paragraphs(a.note) : [];
    if (!quote.length && !note.length) continue;
    const ch = a.chapter?.trim() || null;
    if (ch && ch !== chapter) out.push({ type: 'heading', attrs: { level: 3 }, content: [txt(ch)] });
    if (ch) chapter = ch;
    const id = blockIdOf(a.id);
    if (quote.length) out.push({ type: 'blockquote', attrs: { blockId: id }, content: quote });
    note.forEach((p, i) => out.push(!quote.length && i === 0 ? { ...p, attrs: { blockId: id } } : p));
    const meta = [COLORS[a.color ?? ''] ?? null, a.page ? `p. ${a.page}` : null, day(a.created)].filter(Boolean).join(' · ');
    const italic = [{ type: 'italic' }];
    const line: JSONContent[] = meta ? [{ ...txt(meta), marks: italic }] : [];
    if (reader) {
      const href = `${reader}#note=${encodeURIComponent(a.id)}`;
      if (line.length) line.push({ ...txt(' · '), marks: italic });
      line.push({ ...txt('abrir en el lector'), marks: [...italic, { type: 'link', attrs: { href } }] });
    }
    if (line.length) out.push({ type: 'paragraph', content: line });
  }
  return out;
}

type Book = z.infer<typeof bookRow>;

function saveBook(db: Db, profileId: string, book: Book, list: Annotation[], url: string) {
  const all = liveNotes(db, profileId);
  const existing = all.find((n) => parseProps(n.props)[BOOK_KEY] === book.document) ?? null;
  // Solo los libros de EPUB se abren en el lector en el sitio exacto.
  const reader = book.path && /\.(epub|kepub)$/i.test(book.path) ? `${url}/read/${encodePath(book.path)}` : null;
  const blocks = highlightBlocks(list, reader);
  const count = list.filter((a) => !a.deleted && (a.text?.trim() || a.note?.trim())).length;
  if (!existing && !count) return null;

  const authors = book.authors?.replace(/\n+/g, ', ').trim() || null;
  const propsOf = (raw: string | null | undefined) => {
    const props: Record<string, unknown> = { ...parseProps(raw), [BOOK_KEY]: book.document, [OPDSHELF_KEY]: true };
    if (!authors) return props;
    const def = propertyFor(db, profileId, 'Autor', authors);
    if (def) props[def.id] = coerceProp(db, def, authors);
    return props;
  };

  if (!existing) {
    const title = book.title?.trim() || 'Libro sin título';
    const doc = mergeHighlights(newDoc(title, ''), blocks);
    const note = createNote(db, profileId, { doc, parentId: folderFor(db, profileId, all), props: propsOf(null) });
    return { note, changed: true };
  }
  const doc = mergeHighlights(parseBody(existing.bodyJson) ?? { type: 'doc', content: [] }, blocks);
  const props = JSON.stringify(propsOf(existing.props));
  const bodyJson = JSON.stringify(doc);
  if (bodyJson === existing.bodyJson && props === existing.props) return { note: existing, changed: false };
  return { note: saveNote(db, existing.id, { ...contentOf(doc), props }), changed: true };
}

async function fetchCover(db: Db, fetcher: Fetcher, c: OpdshelfConfig, mediaDir: string, noteId: string, book: Book) {
  const note = liveNotes(db, resolveProfile(db, c.profileId).id).find((n) => n.id === noteId);
  if (!note || parseProps(note.props)[COVER_KEY]) return false;
  const path = book.cover || (book.path ? `/cover/${encodePath(book.path)}` : null);
  if (!path) return false;
  const res = await call(fetcher, c, path.startsWith('http') ? path.slice(c.url.length) : path, 'image/*');
  if (!res.ok) return false;
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length || data.length > MAX_COVER_BYTES) return false;
  const url = await storeImage(mediaDir, (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), data);
  if (!url) return false;
  setBookCover(db, note, url);
  return true;
}

export type SyncSummary = { books: number; created: number; updated: number };

/**
 * Trae de opdshelf los libros cuyos subrayados cambiaron desde la última vez
 * (o todos, con `all`) y actualiza sus notas. Devuelve cuántos tocó.
 */
export async function syncOpdshelf(db: Db, fetcher: Fetcher, opts: { mediaDir?: string; all?: boolean } = {}): Promise<SyncSummary & { changed: boolean }> {
  const c = opdshelfConfig(db);
  if (!c) throw new OpdshelfError('opdshelf no está configurado');
  const state = readState(db);
  try {
    const profile = resolveProfile(db, c.profileId);
    const { books } = await getJson(fetcher, c, '/api/annotations', bookList);
    const todo = books.filter((b) => opts.all || state.seen[b.document] !== b.updated);
    // Los autores: de la lista de libros si opdshelf ya los da; si no, de todos los subrayados.
    if (todo.some((b) => b.authors == null)) {
      const raw = await getJson(fetcher, c, '/api/highlights', highlightList).catch(() => []);
      const rows = Array.isArray(raw) ? raw : raw.highlights;
      const byDoc = new Map(rows.filter((r) => r.authors).map((r) => [r.document, r.authors!]));
      for (const b of todo) b.authors ??= byDoc.get(b.document) ?? null;
    }
    let created = 0;
    let updated = 0;
    let changed = false;
    for (const book of todo) {
      const { annotations } = await getJson(fetcher, c, `/api/annotations/${encodeURIComponent(book.document)}`, annotationList);
      const before = liveNotes(db, profile.id).some((n) => parseProps(n.props)[BOOK_KEY] === book.document);
      const saved = saveBook(db, profile.id, book, annotations, c.url);
      if (saved?.changed) {
        changed = true;
        if (before) updated++;
        else created++;
      }
      if (saved && opts.mediaDir) {
        // Sin portada no pasa nada: el libro se queda sin ella y se vuelve a intentar la próxima vez que cambie.
        if (await fetchCover(db, fetcher, c, opts.mediaDir, saved.note.id, book).catch(() => false)) changed = true;
      }
      state.seen[book.document] = book.updated;
    }
    const live = new Set(books.map((b) => b.document));
    for (const doc of Object.keys(state.seen)) if (!live.has(doc)) delete state.seen[doc];
    writeState(db, { ...state, lastSync: new Date().toISOString(), lastError: null, books: books.length });
    return { books: books.length, created, updated, changed };
  } catch (e) {
    writeState(db, { ...state, lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// ── En segundo plano ──────────────────────────────────────────────────

type Hub = { publish: (e: { scope: 'canvas'; client: string | null }) => void };

const POLL = 5 * 60_000;

/**
 * Mantiene Canvian al día: una conexión en directo a los avisos de opdshelf
 * (/api/progress/events, evento «annotations») y, por si se corta, una vuelta
 * cada 5 minutos. Las sincronizaciones van de una en una.
 */
export function createOpdshelfWorker(db: Db, opts: { fetcher?: Fetcher; mediaDir?: string; hub?: Hub; live?: boolean }) {
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  let queue: Promise<unknown> = Promise.resolve();
  let poll: ReturnType<typeof setInterval> | null = null;
  let live: AbortController | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;

  const sync = (all = false) => {
    const run = queue.then(async () => {
      const r = await syncOpdshelf(db, fetcher, { mediaDir: opts.mediaDir, all });
      if (r.changed) opts.hub?.publish({ scope: 'canvas', client: 'opdshelf' });
      return r;
    });
    queue = run.catch(() => {});
    return run;
  };
  const later = () => {
    if (soon) clearTimeout(soon);
    soon = setTimeout(() => void sync().catch(() => {}), 3000);
  };

  async function listen(signal: AbortSignal) {
    let wait = 5000;
    while (!signal.aborted) {
      const c = opdshelfConfig(db);
      if (!c) return;
      try {
        const res = await fetcher(`${c.url}/api/progress/events?device=Canvian&device_id=canvian`, { signal, headers: { ...headers(c), accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        wait = 5000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const event = /^event:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
            if (event === 'annotations' || event === 'resync' || event === 'library') later();
          }
        }
      } catch {
        // Se corta o no llega: se vuelve a intentar, cada vez más despacio.
      }
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, POLL);
    }
  }

  const stop = () => {
    if (poll) clearInterval(poll);
    poll = null;
    live?.abort();
    live = null;
    if (soon) clearTimeout(soon);
    soon = null;
  };

  /** Empieza (o vuelve a empezar, tras cambiar la conexión). Sin «live» no hace nada: solo se sincroniza a mano. */
  const start = () => {
    stop();
    if (!opts.live || !opdshelfConfig(db)) return;
    poll = setInterval(() => void sync().catch(() => {}), POLL);
    live = new AbortController();
    void listen(live.signal);
    void sync().catch(() => {});
  };

  return { sync, start, stop };
}
export type OpdshelfWorker = ReturnType<typeof createOpdshelfWorker>;
