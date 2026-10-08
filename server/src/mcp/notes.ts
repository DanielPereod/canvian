import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Db } from '../db/index.js';
import { edges, notes, profiles, propertyDefs } from '../db/schema.js';
import { joinTitle, parseBody, splitTitle, splitWiki, titleBlock, titleFrom, type JSONContent } from '../doc/json.js';
import { docText, markdownToDoc, sourceOf } from '../doc/markdown.js';

// Lo que el MCP necesita de las notas, sobre la base directamente (la API de
// la web va con sesión y cookies). Mismas reglas que la web: el título es el
// primer bloque del texto, las hijas cuelgan de zone_id y lo borrado no existe.

export type Note = typeof notes.$inferSelect;
export type Profile = typeof profiles.$inferSelect;

export class McpError extends Error {}

const nowIso = () => new Date().toISOString();
const fold = (s: string) => s.trim().toLocaleLowerCase();
export const INBOX = 'Tareas';

export function listProfiles(db: Db): Profile[] {
  return db.select().from(profiles).orderBy(asc(profiles.position), asc(profiles.createdAt)).all();
}

// Un perfil por su nombre o id; sin decir cuál, el primero (el de arriba en la web).
export function resolveProfile(db: Db, ref?: string | null): Profile {
  const all = listProfiles(db);
  if (!all.length) throw new McpError('Canvian aún no tiene perfiles: abre la web y configura la contraseña.');
  if (!ref) return all[0];
  const hit = all.find((p) => p.id === ref) ?? all.find((p) => fold(p.name) === fold(ref));
  if (!hit) throw new McpError(`No hay ningún perfil «${ref}». Perfiles: ${all.map((p) => p.name).join(', ')}.`);
  return hit;
}

export function liveNotes(db: Db, profileId: string): Note[] {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.profileId, profileId), isNull(notes.deletedAt)))
    .all();
}

export const noteTitle = (n: Pick<Note, 'title' | 'kind'>) => n.title?.trim() || (n.kind === 'canvas' ? 'Canvas sin título' : 'Nota sin título');

// «Abuela > Madre > Nota»: dónde está cada nota.
export function pathOf(byId: Map<string, Note>, note: Note): string {
  const parts = [noteTitle(note)];
  let up = note.zoneId ? byId.get(note.zoneId) : undefined;
  for (let hops = 0; up && hops < 50; hops++) {
    parts.unshift(noteTitle(up));
    up = up.zoneId ? byId.get(up.zoneId) : undefined;
  }
  return parts.join(' > ');
}

// Una nota por su id, por su título o por su ruta («Casa > Reformas»).
export function resolveNote(all: Note[], ref: string): Note {
  const byId = new Map(all.map((n) => [n.id, n]));
  const direct = byId.get(ref.trim());
  if (direct) return direct;
  const want = fold(ref);
  let hits = all.filter((n) => fold(n.title ?? '') === want);
  if (!hits.length && ref.includes('>')) {
    const norm = (s: string) => s.split('>').map(fold).join('>');
    hits = all.filter((n) => norm(pathOf(byId, n)).endsWith(norm(ref)));
  }
  // Si hay varias, las que no están archivadas primero.
  if (hits.length > 1) {
    const active = hits.filter((n) => !n.archivedAt);
    if (active.length === 1) return active[0];
    throw new McpError(
      `Hay ${hits.length} notas que se llaman «${ref}»; usa su id:\n${hits.map((n) => `- ${n.id}: ${pathOf(byId, n)}`).join('\n')}`,
    );
  }
  if (!hits.length) throw new McpError(`No encuentro la nota «${ref}». Búscala con search_notes y usa su id.`);
  return hits[0];
}

export function childrenOf(all: Note[], id: string | null) {
  return all.filter((n) => (n.zoneId ?? null) === id);
}

// Todas las que cuelgan de una nota, a cualquier profundidad.
export function descendantIds(all: Note[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (p: string) => {
    for (const n of all) if (n.zoneId === p && !out.has(n.id)) {
      out.add(n.id);
      walk(n.id);
    }
  };
  walk(id);
  return out;
}

// ── Contenido ─────────────────────────────────────────────────────────

/** El texto de la nota en Markdown, sin el título (que va aparte). */
export function bodyMarkdown(note: Note): string {
  if (note.kind === 'canvas') return note.bodyText ?? '';
  const doc = parseBody(note.bodyJson);
  if (!doc) return note.bodyText ?? '';
  return sourceOf(splitTitle(doc).body);
}

const headingFor = (title: string): JSONContent => ({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] });
const blocksOf = (md: string): JSONContent[] =>
  md.trim() ? (markdownToDoc(md, false).doc.content ?? []).filter((b) => b.type !== 'paragraph' || b.content?.length) : [];

export function newDoc(title: string, md: string): JSONContent {
  const body = blocksOf(md);
  return { type: 'doc', content: [headingFor(title), ...(body.length ? body : [{ type: 'paragraph' }])] };
}

/** El documento con otro título, otro texto o más texto al final. */
export function editDoc(note: Note, change: { title?: string; content?: string; append?: string }): JSONContent {
  const split = splitTitle(parseBody(note.bodyJson) ?? { type: 'doc', content: [] });
  const head = change.title !== undefined ? titleBlock(change.title.trim(), split.head) : split.head;
  let body = split.body.content ?? [];
  if (change.content !== undefined) body = blocksOf(change.content);
  if (change.append?.trim()) {
    // El párrafo vacío que deja el editor al final no hace falta.
    const kept = [...body];
    while (kept.length && kept[kept.length - 1].type === 'paragraph' && !kept[kept.length - 1].content?.length) kept.pop();
    body = [...kept, ...blocksOf(change.append)];
  }
  return joinTitle(head, { type: 'doc', content: body.length ? body : [{ type: 'paragraph' }] });
}

/** Lo que se guarda de una nota con este documento (como hace la web). */
export function contentOf(doc: JSONContent) {
  const bodyText = docText(doc);
  return { bodyJson: JSON.stringify(doc), bodyText, title: titleFrom(bodyText) };
}

// Los [[enlaces]] escritos por su nombre se atan a su nota y, como en la web,
// cada nota enlazada se une a esta en el mapa. Devuelve los que no existen.
export function linkWikis(db: Db, profileId: string, noteId: string, doc: JSONContent): { linked: string[]; missing: string[] } {
  const all = liveNotes(db, profileId);
  const linked = new Set<string>();
  const missing = new Set<string>();
  const walk = (n: JSONContent) => {
    if (n.type === 'wikilink' || n.type === 'noteEmbed') {
      let id = (n.attrs?.id as string | null) ?? null;
      if (!id || !all.some((x) => x.id === id)) {
        const name = splitWiki(String(n.attrs?.target ?? '')).note;
        id = all.find((x) => x.id !== noteId && fold(x.title ?? '') === fold(name))?.id ?? null;
        if (id) n.attrs = { ...n.attrs, id };
        else if (name) missing.add(name);
      }
      if (id && id !== noteId) linked.add(id);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  for (const id of linked) connect(db, profileId, noteId, id);
  return { linked: [...linked], missing: [...missing] };
}

export function connect(db: Db, profileId: string, fromId: string, toId: string) {
  const existing = db
    .select({ id: edges.id })
    .from(edges)
    .where(or(and(eq(edges.fromId, fromId), eq(edges.toId, toId)), and(eq(edges.fromId, toId), eq(edges.toId, fromId))))
    .get();
  if (existing) return false;
  db.insert(edges).values({ id: ulid(), profileId, fromId, toId }).run();
  return true;
}

export function createNote(db: Db, profileId: string, values: { doc: JSONContent; parentId: string | null; props?: Record<string, unknown> }): Note {
  return db
    .insert(notes)
    .values({
      id: ulid(),
      profileId,
      kind: 'text',
      ...contentOf(values.doc),
      zoneId: values.parentId,
      props: JSON.stringify(values.props ?? {}),
      x: 0,
      y: 0,
    })
    .returning()
    .get();
}

export function saveNote(db: Db, id: string, set: Partial<Note>): Note {
  return db
    .update(notes)
    .set({ ...set, updatedAt: nowIso() })
    .where(eq(notes.id, id))
    .returning()
    .get()!;
}

// ── Propiedades ───────────────────────────────────────────────────────

export type PropertyDef = typeof propertyDefs.$inferSelect;

export function propertyDefsOf(db: Db, profileId: string): PropertyDef[] {
  return db.select().from(propertyDefs).where(eq(propertyDefs.profileId, profileId)).orderBy(asc(propertyDefs.position)).all();
}

export function parseProps(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Las propiedades de una nota, por su nombre. */
export function propsByName(defs: PropertyDef[], note: Note): Record<string, unknown> {
  const props = parseProps(note.props);
  const out: Record<string, unknown> = {};
  for (const d of defs) if (props[d.id] !== undefined && props[d.id] !== null) out[d.name] = props[d.id];
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const typeFor = (v: unknown) => (Array.isArray(v) ? 'tags' : typeof v === 'boolean' ? 'checkbox' : typeof v === 'number' ? 'number' : typeof v === 'string' && DAY.test(v) ? 'date' : typeof v === 'string' && /^https?:\/\//.test(v) ? 'url' : 'text');

/** La propiedad de ese nombre (se crea si no existe y hay valor que poner). */
export function propertyFor(db: Db, profileId: string, name: string, value: unknown, type?: string): PropertyDef | null {
  const defs = propertyDefsOf(db, profileId);
  const hit = defs.find((d) => fold(d.name) === fold(name));
  if (hit || value === null) return hit ?? null;
  return db
    .insert(propertyDefs)
    .values({ id: ulid(), profileId, name: name.trim(), type: type ?? typeFor(value), options: '[]', appliesTo: 'all', position: defs.length ? Math.max(...defs.map((d) => d.position)) + 1 : 0 })
    .returning()
    .get();
}

/** Comprueba y adapta el valor al tipo de la propiedad (y añade opciones nuevas a una lista). */
export function coerceProp(db: Db, def: PropertyDef, value: unknown): unknown {
  if (value === null) return null;
  const bad = () => new McpError(`«${def.name}» es de tipo ${def.type}; ese valor no le vale.`);
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw bad();
      return n;
    }
    case 'checkbox':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw bad();
    case 'date':
      if (typeof value === 'string' && DAY.test(value.slice(0, 10))) return value.slice(0, 10);
      throw bad();
    case 'tags': {
      const list = (Array.isArray(value) ? value : String(value).split(',')).map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
      const tags = [...new Map(list.map((t) => [t.toLowerCase(), t])).values()].slice(0, 40);
      remember(db, def, tags);
      return tags;
    }
    case 'select': {
      const v = String(value).trim();
      const options = JSON.parse(def.options) as string[];
      if (v && !options.some((o) => fold(o) === fold(v))) {
        db.update(propertyDefs).set({ options: JSON.stringify([...options, v]) }).where(eq(propertyDefs.id, def.id)).run();
      }
      return options.find((o) => fold(o) === fold(v)) ?? v;
    }
    default:
      return String(value).slice(0, 2000);
  }
}

// Las etiquetas usadas quedan como sugerencias de la propiedad (como en la web).
function remember(db: Db, def: PropertyDef, tags: string[]) {
  const options = JSON.parse(def.options) as string[];
  const add = tags.filter((t) => !options.some((o) => fold(o) === fold(t)));
  if (add.length) db.update(propertyDefs).set({ options: JSON.stringify([...options, ...add]) }).where(eq(propertyDefs.id, def.id)).run();
}

/** La propiedad de etiquetas del perfil; si aún no hay ninguna, se crea «Etiquetas» (como en la web). */
export function tagsDef(db: Db, profileId: string): PropertyDef {
  const defs = propertyDefsOf(db, profileId);
  return defs.find((d) => d.type === 'tags') ?? propertyFor(db, profileId, 'Etiquetas', [])!;
}

/** Las props de una nota con estas etiquetas añadidas. */
export function withTags(db: Db, profileId: string, raw: string | null | undefined, tags: string[]): Record<string, unknown> {
  const def = tagsDef(db, profileId);
  const props = parseProps(raw);
  const had = Array.isArray(props[def.id]) ? (props[def.id] as string[]) : [];
  return { ...props, [def.id]: coerceProp(db, def, [...had, ...tags]) };
}

/** Las etiquetas de la nota (de todas sus propiedades de tipo etiquetas). */
export function noteTags(defs: PropertyDef[], note: Note): string[] {
  const props = parseProps(note.props);
  const out: string[] = [];
  for (const d of defs) {
    const v = props[d.id];
    if (d.type === 'tags' && Array.isArray(v)) for (const t of v) if (!out.some((o) => fold(o) === fold(String(t)))) out.push(String(t));
  }
  return out;
}

// Para la búsqueda: el texto que rodea lo encontrado.
export const snippetSql = sql<string>`snippet(notes_fts, 1, '«', '»', '…', 16)`;
