import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { joinTitle, parseBody, splitTitle, type JSONContent } from '../doc/json.js';
import { notes } from '../db/schema.js';
import { coerceProp, contentOf, createNote, liveNotes, newDoc, parseProps, propertyDefsOf, propertyFor, resolveProfile, saveNote, type Note } from '../mcp/notes.js';

// Sincronización con KOReader: el plugin (ver server/koreader) manda los
// subrayados y notas de cada libro y aquí se guardan en una nota por libro,
// dentro de la carpeta elegida en Configuración › KOReader. Volver a mandar el
// mismo libro actualiza su nota (nunca la duplica): se reconoce por la huella
// que KOReader calcula del archivo, guardada en la propiedad reservada «koreader».

const TOKEN = 'koreader_token';
const folderKey = (profileId: string) => `koreader_folder:${profileId}`;
/** Propiedad reservada (como «noTasks»): la huella del libro. */
export const BOOK_KEY = 'koreader';
/** Propiedad reservada: la portada que ya se subió (no se vuelve a pedir, aunque luego se quite). */
export const COVER_KEY = 'koreaderCover';
const COVER_PROP = 'Portada';
/** El encabezado desde el que la nota es de KOReader; lo de encima se respeta. */
export const SECTION = 'Subrayados';
const FOLDER_TITLE = 'KOReader';

const get = (db: Db, key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const put = (db: Db, key: string, value: string) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
const drop = (db: Db, key: string) => db.delete(settings).where(eq(settings.key, key)).run();
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export class KoreaderError extends Error {}

// ── La llave ──────────────────────────────────────────────────────────

export const koreaderToken = (db: Db) => get(db, TOKEN);

export function createKoreaderToken(db: Db): string {
  const token = randomBytes(24).toString('base64url');
  put(db, TOKEN, token);
  return token;
}

export const revokeKoreaderToken = (db: Db) => drop(db, TOKEN);

export function isKoreaderToken(db: Db, token: string | null | undefined): boolean {
  const saved = koreaderToken(db);
  return !!token && !!saved && timingSafeEqual(sha256(token), sha256(saved));
}

// ── La carpeta de cada perfil ─────────────────────────────────────────

export const koreaderFolder = (db: Db, profileId: string) => get(db, folderKey(profileId));

export function setKoreaderFolder(db: Db, profileId: string, noteId: string | null) {
  if (noteId) put(db, folderKey(profileId), noteId);
  else drop(db, folderKey(profileId));
}

/** La nota carpeta del perfil; si no hay ninguna elegida (o ya no existe), una nota «KOReader» en la raíz. */
function folderFor(db: Db, profileId: string, all: Note[]): string {
  const chosen = koreaderFolder(db, profileId);
  if (chosen && all.some((n) => n.id === chosen)) return chosen;
  const made = all.find((n) => !n.zoneId && !n.archivedAt && n.title?.trim() === FOLDER_TITLE) ?? createNote(db, profileId, { doc: newDoc(FOLDER_TITLE, ''), parentId: null });
  setKoreaderFolder(db, profileId, made.id);
  return made.id;
}

// ── Lo que manda el plugin ────────────────────────────────────────────

const str = (max: number) => z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().max(max)).nullish().catch(null);
// El JSON de Lua manda las listas vacías como objetos ({}).
const list = <T extends z.ZodTypeAny>(item: T) => z.preprocess((v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v) : v), z.array(item).max(5000));

const annotation = z.object({
  text: str(20_000),
  note: str(20_000),
  chapter: str(300),
  page: str(20),
  datetime: str(40),
});

export const syncBody = z.object({
  profile: z.string().max(100).nullish(),
  book: z.object({
    key: z.string().trim().min(1).max(200),
    title: z.string().trim().max(300).nullish(),
    authors: z.string().trim().max(300).nullish(),
  }),
  annotations: list(annotation),
});
export type SyncBody = z.infer<typeof syncBody>;
type Annotation = z.infer<typeof annotation>;

const txt = (text: string): JSONContent => ({ type: 'text', text });
const paragraphs = (text: string): JSONContent[] =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ type: 'paragraph', content: [txt(l)] }));

/** Los subrayados como bloques: por capítulos, cada uno citado, con su nota debajo y de qué página es. */
export function highlightBlocks(list: Annotation[]): JSONContent[] {
  const out: JSONContent[] = [{ type: 'heading', attrs: { level: 2 }, content: [txt(SECTION)] }];
  let chapter: string | null = null;
  for (const a of list) {
    const quote = a.text ? paragraphs(a.text) : [];
    const note = a.note ? paragraphs(a.note) : [];
    if (!quote.length && !note.length) continue;
    const ch = a.chapter?.trim() || null;
    if (ch && ch !== chapter) out.push({ type: 'heading', attrs: { level: 3 }, content: [txt(ch)] });
    if (ch) chapter = ch;
    if (quote.length) out.push({ type: 'blockquote', content: quote });
    out.push(...note);
    const meta = [a.page ? `p. ${a.page}` : null, a.datetime ? a.datetime.slice(0, 10) : null].filter(Boolean).join(' · ');
    if (meta) out.push({ type: 'paragraph', content: [{ ...txt(meta), marks: [{ type: 'italic' }] }] });
  }
  return out;
}

const isSection = (b: JSONContent) =>
  b.type === 'heading' && b.attrs?.level === 2 && (b.content ?? []).map((c) => c.text ?? '').join('').trim() === SECTION;
const isEmpty = (b: JSONContent) => b.type === 'paragraph' && !b.content?.length;

/** El documento de la nota con los subrayados nuevos: lo de encima de «Subrayados» se queda. */
export function mergeHighlights(doc: JSONContent, blocks: JSONContent[]): JSONContent {
  const split = splitTitle(doc);
  const body = split.body.content ?? [];
  const at = body.findIndex(isSection);
  const kept = at < 0 ? [...body] : body.slice(0, at);
  while (kept.length && isEmpty(kept[kept.length - 1])) kept.pop();
  return joinTitle(split.head, { type: 'doc', content: [...kept, ...blocks] });
}

/** cover: si Canvian aún no tiene la portada del libro y el plugin debería mandarla. */
export type SyncResult = { id: string; title: string; created: boolean; changed: boolean; count: number; cover: boolean } | { skipped: true };

const wantsCover = (props: Record<string, unknown>) => !props[COVER_KEY];

export function syncBook(db: Db, body: SyncBody): SyncResult {
  const profile = resolveProfile(db, body.profile || null);
  const all = liveNotes(db, profile.id);
  const key = body.book.key;
  const existing = all.find((n) => parseProps(n.props)[BOOK_KEY] === key) ?? null;
  const blocks = highlightBlocks(body.annotations);
  const count = body.annotations.filter((a) => a.text?.trim() || a.note?.trim()).length;
  // Un libro sin nada subrayado no merece nota (pero si ya la tiene, se vacía).
  if (!existing && !count) return { skipped: true };

  const authors = body.book.authors?.replace(/\n+/g, ', ').trim() || null;
  const withAuthor = (raw: string | null | undefined) => {
    const props: Record<string, unknown> = { ...parseProps(raw), [BOOK_KEY]: key };
    if (!authors) return props;
    const def = propertyFor(db, profile.id, 'Autor', authors);
    if (def) props[def.id] = coerceProp(db, def, authors);
    return props;
  };

  if (!existing) {
    const title = body.book.title || 'Libro sin título';
    const doc = mergeHighlights(newDoc(title, ''), blocks);
    const note = createNote(db, profile.id, { doc, parentId: folderFor(db, profile.id, all), props: withAuthor(null) });
    return { id: note.id, title, created: true, changed: true, count, cover: true };
  }

  const doc = mergeHighlights(parseBody(existing.bodyJson) ?? { type: 'doc', content: [] }, blocks);
  const props = JSON.stringify(withAuthor(existing.props));
  const bodyJson = JSON.stringify(doc);
  const changed = bodyJson !== existing.bodyJson || props !== existing.props;
  if (changed) saveNote(db, existing.id, { ...contentOf(doc), props });
  return { id: existing.id, title: existing.title ?? body.book.title ?? '', created: false, changed, count, cover: wantsCover(parseProps(existing.props)) };
}

// ── La portada ────────────────────────────────────────────────────────

/** Una nota de libro de KOReader (las demás no se tocan desde el plugin). */
export function bookNote(db: Db, id: string): Note | null {
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  return note && !note.deletedAt && parseProps(note.props)[BOOK_KEY] ? note : null;
}

/**
 * Pone la portada subida en la propiedad de tipo Imagen «Portada» (la que usa
 * la galería). Si la nota ya tenía ahí otra imagen, se respeta.
 */
export function setBookCover(db: Db, note: Note, url: string): Note {
  const defs = propertyDefsOf(db, note.profileId);
  const fold = (s: string) => s.trim().toLocaleLowerCase();
  const def =
    defs.find((d) => d.type === 'image' && fold(d.name) === fold(COVER_PROP)) ??
    defs.find((d) => d.type === 'image') ??
    propertyFor(db, note.profileId, defs.some((d) => fold(d.name) === fold(COVER_PROP)) ? `${COVER_PROP} del libro` : COVER_PROP, url, 'image')!;
  const props = parseProps(note.props);
  if (!props[def.id]) props[def.id] = url;
  props[COVER_KEY] = url;
  return saveNote(db, note.id, { props: JSON.stringify(props) });
}
