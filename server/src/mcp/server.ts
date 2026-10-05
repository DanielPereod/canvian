import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { notes } from '../db/schema.js';
import { toFtsQuery } from '../routes/canvas.js';
import { addTaskItem, allTasks, changeTask, listedTasks, newTaskItem, parseRecur, recurs, recurText, setToday, type Task, type TaskStatus } from '../doc/tasks.js';
import { parseBody, sectionOf, splitTitle } from '../doc/json.js';
import { docToMarkdown } from '../doc/markdown.js';
import {
  INBOX,
  McpError,
  bodyMarkdown,
  childrenOf,
  coerceProp,
  connect,
  contentOf,
  createNote,
  descendantIds,
  editDoc,
  linkWikis,
  liveNotes,
  listProfiles,
  newDoc,
  noteTags,
  noteTitle,
  parseProps,
  pathOf,
  propertyDefsOf,
  propertyFor,
  propsByName,
  resolveNote,
  resolveProfile,
  saveNote,
  snippetSql,
  withTags,
  type Note,
} from './notes.js';

// El servidor MCP de Canvian: deja que Claude (u otro cliente MCP) lea y
// escriba las notas y tareas. Cada petición crea uno nuevo (sin estado).

// «Hoy» es el de la zona del servidor (TZ en el docker-compose), no el de UTC.
export function localDay(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
setToday(() => localDay());
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const INSTRUCTIONS = `Canvian es la app de notas de Dani (en español). Cómo funciona:
- Todo son notas. Una nota puede estar dentro de otra (su «madre»); las rutas se escriben «Casa > Reformas > Baño».
- El texto de las notas se lee y escribe en Markdown (estilo Obsidian): [[Otra nota]] enlaza notas, ==resaltado==, > [!note] avisos.
- Un bloque puede llevar un id al final de su línea («texto ^abc123»); [[Nota#^abc123]] enlaza ese punto exacto y [[Nota#Encabezado]] esa sección. get_note con «Nota#^abc123» lee solo ese trozo.
- Las tareas no son notas: son las casillas «- [ ] texto» dentro de las notas. Detrás del texto llevan «📅 AAAA-MM-DD» (fecha), «⏫ 🔼 🔽» (prioridad alta/media/baja), «#etiqueta», «🔁 every week» si se repite (como en Obsidian Tasks) y, hechas, «✅ AAAA-MM-DD». Al hacer una que se repite se apunta encima la siguiente vez, con su fecha. «[/]» es en curso y «[!]» bloqueada. Una casilla sangrada bajo otra es su subtarea.
- Lo que se apunta sin decir dónde va a la nota «${INBOX}».
- Hay perfiles (por ejemplo Personal y Trabajo) que no se mezclan; sin indicar ninguno se usa el primero.
- Archivar oculta una nota (y lo que tiene dentro) sin borrarla.
Usa los ids que devuelven las herramientas para referirte a notas y tareas. Escribe en el idioma de las notas.`;

// «Nota#^abc123» o «Nota#Encabezado»: la nota y el punto. Si el título
// lleva «#» de verdad, manda el título entero.
function noteAndSection(all: Note[], ref: string): { n: Note; section: string | null } {
  try {
    return { n: resolveNote(all, ref), section: null };
  } catch (e) {
    const hash = ref.indexOf('#');
    if (hash < 1 || !(e instanceof McpError)) throw e;
    return { n: resolveNote(all, ref.slice(0, hash)), section: ref.slice(hash + 1).trim() || null };
  }
}

const profileArg = z.string().optional().describe('Perfil (nombre o id). Por defecto, el primero.');
const noteArg = (what = 'La nota') => z.string().min(1).describe(`${what}: su id, su título o su ruta («Casa > Reformas»).`);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
// «09:30» o «09:30-11:00»: la hora de empezar (el día de `start` o `due`) y la de acabar (el de `due`).
const timeArg = z
  .string()
  .regex(/^\d{1,2}:\d{2}(\s*-\s*\d{1,2}:\d{2})?$/, 'Hora HH:MM o HH:MM-HH:MM')
  .describe('Horas, «09:30» o «09:30-11:00» (como un bloque en el calendario). Necesita `due`.');
const timesOf = (time: string) => {
  const [a, b] = time.split('-').map((x) => x.trim());
  return { startTime: a, endTime: b ?? null };
};
const STATUS = ['todo', 'doing', 'blocked', 'done'] as const;
const PRIORITY = { none: 0, low: 1, medium: 2, high: 3 } as const;
const priorityArg = z.enum(['none', 'low', 'medium', 'high']);
// «every week» y compañía (Obsidian Tasks); se guarda escrita como la entiende Obsidian.
const repeatArg = z
  .string()
  .trim()
  .max(80)
  .describe('Cada cuánto se repite, en inglés como en Obsidian Tasks: every day, every 2 weeks, every week on Monday, Friday, every weekday, every month on the 15th, every month on the last, every year; «when done» al final cuenta desde que se hace.');
function recurArg(rule: string): string {
  const r = parseRecur(rule);
  if (!r) throw new McpError(`No entiendo «${rule}» como repetición. Prueba «every week» o «every 2 days».`);
  return recurText(r);
}
const priorityName = (p: number) => (['none', 'low', 'medium', 'high'] as const)[p] ?? 'none';

type Hub = { publish: (e: { scope: 'canvas'; client: string | null }) => void };

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const data = (value: unknown) => text(JSON.stringify(value, null, 2));

export function createMcpServer(db: Db, hub?: Hub) {
  const server = new McpServer({ name: 'canvian', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  // Las demás pantallas abiertas se enteran de lo que cambia Claude.
  const changed = () => hub?.publish({ scope: 'canvas', client: 'mcp' });

  // Errores esperables (una nota que no existe…) vuelven como texto para Claude.
  const run =
    <A,>(fn: (args: A) => ReturnType<typeof text>) =>
    async (args: A) => {
      try {
        return fn(args);
      } catch (e) {
        if (e instanceof McpError) return { ...text(e.message), isError: true };
        throw e;
      }
    };

  const ctx = (profile?: string) => {
    const p = resolveProfile(db, profile);
    const all = liveNotes(db, p.id);
    return { profile: p, all, byId: new Map(all.map((n) => [n.id, n])) };
  };
  const brief = (byId: Map<string, Note>, n: Note) => ({
    id: n.id,
    title: noteTitle(n),
    path: pathOf(byId, n),
    ...(n.kind !== 'text' ? { kind: n.kind } : {}),
    ...(n.archivedAt ? { archived: true } : {}),
    updated: n.updatedAt,
  });
  const taskOut = (byId: Map<string, Note>, t: Task) => ({
    id: t.id,
    text: t.title,
    status: t.status,
    ...(t.startAt ? { start: t.startAt } : {}),
    ...(t.dueAt ? { due: t.dueAt } : {}),
    ...(t.startTime ? { time: t.endTime ? `${t.startTime}-${t.endTime}` : t.startTime } : {}),
    ...(t.priority ? { priority: priorityName(t.priority) } : {}),
    ...(t.tags.length ? { tags: t.tags } : {}),
    ...(t.repeat ? { repeat: t.repeat } : {}),
    ...(t.doneAt ? { done: t.doneAt } : {}),
    ...(t.parentId ? { subtaskOf: t.parentId } : {}),
    note: byId.get(t.noteId) ? pathOf(byId, byId.get(t.noteId)!) : t.noteId,
  });
  // Lo archivado (o dentro de algo archivado) no se ve salvo que se pida.
  const hiddenIds = (all: Note[]) => {
    const out = new Set<string>();
    for (const n of all) if (n.archivedAt) {
      out.add(n.id);
      for (const d of descendantIds(all, n.id)) out.add(d);
    }
    return out;
  };
  const textNote = (n: Note) => {
    if (n.kind !== 'text') throw new McpError(`«${noteTitle(n)}» es un ${n.kind === 'canvas' ? 'canvas' : n.kind}: su contenido no se puede editar desde aquí.`);
    return n;
  };

  // ── Perfiles y lectura ──────────────────────────────────────────────

  server.registerTool(
    'list_profiles',
    { title: 'Perfiles', description: 'Los perfiles de Canvian (cada uno con sus propias notas).', annotations: { readOnlyHint: true } },
    run(() => data(listProfiles(db).map((p, i) => ({ id: p.id, name: p.name, ...(i === 0 ? { default: true } : {}) })))),
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Buscar notas',
      description: 'Busca notas por texto (título y contenido, sin distinguir acentos) y/o por etiqueta. Sin texto ni etiqueta, devuelve las editadas más recientemente.',
      inputSchema: {
        query: z.string().optional().describe('Palabras a buscar (encuentra también prefijos: «presu» → «presupuesto»).'),
        tag: z.string().optional().describe('Solo notas con esta etiqueta.'),
        within: z.string().optional().describe('Solo notas dentro de esta (id, título o ruta), a cualquier profundidad.'),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Por defecto 20.'),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(({ query, tag, within, include_archived, limit = 20, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const hidden = include_archived ? new Set<string>() : hiddenIds(all);
      const inside = within ? descendantIds(all, resolveNote(all, within).id) : null;
      const defs = propertyDefsOf(db, p.id);
      const keep = (n: Note) =>
        !hidden.has(n.id) && (!inside || inside.has(n.id)) && (!tag || noteTags(defs, n).some((t) => t.toLowerCase() === tag.replace(/^#/, '').toLowerCase()));
      const q = toFtsQuery(query ?? '');
      let hits: { note: Note; snippet?: string }[];
      if (q) {
        const rows = db
          .select({ id: notes.id, snippet: snippetSql })
          .from(notes)
          .innerJoin(sql`notes_fts`, sql`notes_fts.rowid = ${notes}.rowid`)
          .where(and(eq(notes.profileId, p.id), isNull(notes.deletedAt), sql`notes_fts MATCH ${q}`))
          .orderBy(sql`bm25(notes_fts, 4.0, 1.0)`)
          .limit(500)
          .all();
        hits = rows.flatMap((r) => (byId.get(r.id) ? [{ note: byId.get(r.id)!, snippet: r.snippet }] : []));
      } else {
        hits = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((note) => ({ note }));
      }
      hits = hits.filter((h) => keep(h.note)).slice(0, limit);
      return data(hits.map((h) => ({ ...brief(byId, h.note), ...(h.snippet ? { snippet: h.snippet.replace(/\s+/g, ' ').trim() } : {}) })));
    }),
  );

  server.registerTool(
    'get_note',
    {
      title: 'Leer nota',
      description: 'Lee una nota entera: su texto en Markdown, dónde está, sus notas hijas, propiedades, etiquetas, enlaces y tareas. Con «Nota#^id» o «Nota#Encabezado» devuelve además ese trozo en «section».',
      inputSchema: { note: noteArg(), profile: profileArg },
      annotations: { readOnlyHint: true },
    },
    run(({ note, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const { n, section } = noteAndSection(all, note);
      const part = section ? sectionOf(splitTitle(parseBody(n.bodyJson)).body, section) : null;
      if (section && !part) throw new McpError(`La nota «${noteTitle(n)}» no tiene «#${section}».`);
      const defs = propertyDefsOf(db, p.id);
      const edgesOf = db.all<{ other: string }>(sql`SELECT CASE WHEN from_id = ${n.id} THEN to_id ELSE from_id END AS other FROM edges WHERE from_id = ${n.id} OR to_id = ${n.id}`);
      const linked = edgesOf.flatMap((e) => (byId.get(e.other) ? [brief(byId, byId.get(e.other)!)] : []));
      const props = propsByName(defs, n);
      const tasks = allTasks([n]).map((t) => taskOut(byId, t));
      return data({
        ...brief(byId, n),
        created: n.createdAt,
        parent: n.zoneId && byId.get(n.zoneId) ? { id: n.zoneId, title: noteTitle(byId.get(n.zoneId)!) } : null,
        children: childrenOf(all, n.id).map((c) => ({ id: c.id, title: noteTitle(c), ...(c.archivedAt ? { archived: true } : {}) })),
        ...(Object.keys(props).length ? { properties: props } : {}),
        ...(linked.length ? { linkedNotes: linked.map(({ id, title, path }) => ({ id, title, path })) } : {}),
        ...(tasks.length ? { tasks } : {}),
        markdown: bodyMarkdown(n),
        ...(part ? { section: docToMarkdown({ type: 'doc', content: part }) } : {}),
      });
    }),
  );

  server.registerTool(
    'list_notes',
    {
      title: 'Árbol de notas',
      description: 'Las notas que hay dentro de una (o las de arriba del todo), como un índice con sangría.',
      inputSchema: {
        parent: z.string().optional().describe('La nota madre (id, título o ruta). Sin ella, las de arriba del todo.'),
        depth: z.number().int().min(1).max(6).optional().describe('Cuántos niveles bajar. Por defecto 2.'),
        include_archived: z.boolean().optional(),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(({ parent, depth = 2, include_archived, profile }) => {
      const { all } = ctx(profile);
      const root = parent ? resolveNote(all, parent) : null;
      const lines: string[] = [];
      const walk = (id: string | null, level: number) => {
        const kids = childrenOf(all, id)
          .filter((k) => include_archived || !k.archivedAt)
          .sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), 'es'));
        for (const k of kids) {
          const more = childrenOf(all, k.id).length;
          lines.push(`${'  '.repeat(level)}- ${noteTitle(k)} (${k.id})${k.kind === 'canvas' ? ' [canvas]' : ''}${k.archivedAt ? ' [archivada]' : ''}${level + 1 >= depth && more ? ` [+${more} dentro]` : ''}`);
          if (level + 1 < depth) walk(k.id, level + 1);
        }
      };
      walk(root?.id ?? null, 0);
      return text(lines.length ? lines.join('\n') : root ? `«${noteTitle(root)}» no tiene notas dentro.` : 'No hay notas.');
    }),
  );

  // ── Escribir ────────────────────────────────────────────────────────

  server.registerTool(
    'create_note',
    {
      title: 'Crear nota',
      description: 'Crea una nota con su título y texto en Markdown (puede llevar [[enlaces]] a otras notas por su título, casillas «- [ ]», tablas…).',
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        markdown: z.string().max(200_000).optional().describe('El texto, sin repetir el título.'),
        parent: z.string().optional().describe('Nota madre (id, título o ruta). Sin ella, va arriba del todo.'),
        tags: z.array(z.string()).optional(),
        profile: profileArg,
      },
    },
    run(({ title, markdown, parent, tags, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const mother = parent ? resolveNote(all, parent) : null;
      const doc = newDoc(title, markdown ?? '');
      const props = tags?.length ? withTags(db, p.id, null, tags) : undefined;
      let row = createNote(db, p.id, { doc, parentId: mother?.id ?? null, props });
      const links = linkWikis(db, p.id, row.id, doc);
      if (links.linked.length) row = saveNote(db, row.id, contentOf(doc));
      changed();
      byId.set(row.id, row);
      return data({ created: brief(byId, row), ...(links.missing.length ? { linksToMissingNotes: links.missing } : {}) });
    }),
  );

  server.registerTool(
    'update_note',
    {
      title: 'Editar nota',
      description: 'Cambia el título de una nota, sustituye todo su texto o le añade texto al final (Markdown). Para reescribir, lee antes la nota con get_note.',
      inputSchema: {
        note: noteArg(),
        title: z.string().trim().min(1).max(200).optional(),
        markdown: z.string().max(200_000).optional().describe('Texto nuevo que sustituye todo el anterior (sin el título).'),
        append: z.string().max(200_000).optional().describe('Texto que se añade al final.'),
        profile: profileArg,
      },
    },
    run(({ note, title, markdown, append, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const n = textNote(resolveNote(all, note));
      if (title === undefined && markdown === undefined && !append) throw new McpError('No hay nada que cambiar: pasa title, markdown o append.');
      const doc = editDoc(n, { title, content: markdown, append });
      const links = linkWikis(db, p.id, n.id, doc);
      const row = saveNote(db, n.id, contentOf(doc));
      changed();
      byId.set(row.id, row);
      return data({ updated: brief(byId, row), ...(links.missing.length ? { linksToMissingNotes: links.missing } : {}) });
    }),
  );

  server.registerTool(
    'link_notes',
    {
      title: 'Unir notas',
      description: 'Une dos notas en el mapa (el grafo). Para enlazar desde el texto, escribe [[Título]] con update_note.',
      inputSchema: { from: noteArg('Una nota'), to: noteArg('La otra'), profile: profileArg },
    },
    run(({ from, to, profile }) => {
      const { profile: p, all } = ctx(profile);
      const a = resolveNote(all, from);
      const b = resolveNote(all, to);
      if (a.id === b.id) throw new McpError('Una nota no se puede unir consigo misma.');
      const made = connect(db, p.id, a.id, b.id);
      if (made) changed();
      return text(made ? `Unidas «${noteTitle(a)}» y «${noteTitle(b)}».` : 'Ya estaban unidas.');
    }),
  );

  // ── Organizar ───────────────────────────────────────────────────────

  server.registerTool(
    'move_note',
    {
      title: 'Mover nota',
      description: 'Mueve una nota (con todo lo que tiene dentro) a otra nota madre, o arriba del todo.',
      inputSchema: {
        note: noteArg(),
        parent: z.string().nullable().describe('La nueva madre (id, título o ruta), o null para dejarla arriba del todo.'),
        profile: profileArg,
      },
    },
    run(({ note, parent, profile }) => {
      const { all, byId } = ctx(profile);
      const n = resolveNote(all, note);
      const mother = parent ? resolveNote(all, parent) : null;
      if (mother && (mother.id === n.id || descendantIds(all, n.id).has(mother.id))) throw new McpError('No se puede meter una nota dentro de sí misma.');
      const row = saveNote(db, n.id, { zoneId: mother?.id ?? null });
      byId.set(row.id, row);
      changed();
      return text(`Ahora está en: ${pathOf(byId, row)}`);
    }),
  );

  server.registerTool(
    'archive_note',
    {
      title: 'Archivar nota',
      description: 'Archiva una nota (se oculta con todo lo que tiene dentro, sin borrarse) o la recupera.',
      inputSchema: { note: noteArg(), archived: z.boolean().optional().describe('false para desarchivar. Por defecto true.'), profile: profileArg },
    },
    run(({ note, archived = true, profile }) => {
      const { all } = ctx(profile);
      const n = resolveNote(all, note);
      saveNote(db, n.id, { archivedAt: archived ? new Date().toISOString() : null });
      changed();
      return text(`«${noteTitle(n)}» ${archived ? 'archivada' : 'desarchivada'}.`);
    }),
  );

  server.registerTool(
    'set_property',
    {
      title: 'Poner propiedad',
      description:
        'Pone (o quita, con null) una propiedad de una nota, como «Estado» o «Etiquetas». Si la propiedad no existe se crea, con el tipo según el valor (lista → etiquetas, true/false → casilla, número, fecha AAAA-MM-DD, enlace o texto).',
      inputSchema: {
        note: noteArg(),
        property: z.string().trim().min(1).max(60),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
        profile: profileArg,
      },
    },
    run(({ note, property, value, profile }) => {
      const { profile: p, all } = ctx(profile);
      const n = resolveNote(all, note);
      const def = propertyFor(db, p.id, property, value);
      if (!def) return text(`«${noteTitle(n)}» no tenía «${property}».`);
      const props = parseProps(n.props);
      const v = coerceProp(db, def, value);
      if (v === null) delete props[def.id];
      else props[def.id] = v;
      saveNote(db, n.id, { props: JSON.stringify(props) });
      changed();
      return text(v === null ? `Quitada «${def.name}» de «${noteTitle(n)}».` : `«${noteTitle(n)}»: ${def.name} = ${JSON.stringify(v)}`);
    }),
  );

  // ── Tareas ──────────────────────────────────────────────────────────

  server.registerTool(
    'list_tasks',
    {
      title: 'Tareas',
      description: 'Lista tareas (las casillas de las notas). Por defecto, todas las pendientes, primero las que tienen fecha.',
      inputSchema: {
        when: z
          .enum(['all', 'today', 'overdue', 'upcoming', 'no_date'])
          .optional()
          .describe('today: para hoy, atrasadas o de varios días que ya empezaron; overdue: solo atrasadas; upcoming: los próximos `days` días; no_date: sin fecha.'),
        days: z.number().int().min(1).max(365).optional().describe('Para upcoming. Por defecto 7.'),
        status: z.enum(['open', 'done', 'any', ...STATUS]).optional().describe('open (por defecto) = sin hacer.'),
        note: z.string().optional().describe('Solo las de esta nota y las que tiene dentro.'),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Por defecto 100.'),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(({ when = 'all', days = 7, status = 'open', note, tag, limit = 100, profile }) => {
      const { all, byId } = ctx(profile);
      const hidden = hiddenIds(all);
      let scope = all.filter((n) => !hidden.has(n.id));
      if (note) {
        const root = resolveNote(all, note);
        const ids = descendantIds(all, root.id).add(root.id);
        scope = all.filter((n) => ids.has(n.id));
      }
      const today = localDay();
      const until = addDays(today, days);
      const tasks = (note ? allTasks(scope) : listedTasks(scope)).filter((t) => {
        if (status === 'open' ? t.status === 'done' : status !== 'any' && t.status !== status) return false;
        if (tag && !t.tags.some((x) => x.toLowerCase() === tag.replace(/^#/, '').toLowerCase())) return false;
        // Las de varios días cuentan desde que empiezan.
        if (when === 'today') return !!t.dueAt && (t.dueAt <= today || (!!t.startAt && t.startAt <= today));
        if (when === 'overdue') return !!t.dueAt && t.dueAt < today;
        if (when === 'upcoming') return !!t.dueAt && t.dueAt >= today && (t.startAt && t.startAt < t.dueAt ? t.startAt : t.dueAt) <= until;
        if (when === 'no_date') return !t.dueAt;
        return true;
      });
      tasks.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || b.priority - a.priority);
      return data({ today, count: tasks.length, tasks: tasks.slice(0, limit).map((t) => taskOut(byId, t)) });
    }),
  );

  server.registerTool(
    'add_task',
    {
      title: 'Añadir tarea',
      description: `Añade una tarea (una casilla) al final de una nota, o a «${INBOX}» si no se dice dónde. Puede ser subtarea de otra.`,
      inputSchema: {
        text: z.string().trim().min(1).max(1000).describe('El texto (Markdown en línea; puede llevar [[enlaces]] y #etiquetas).'),
        due: day.optional(),
        start: day.optional().describe('Si dura varios días, el día en que empieza (hasta `due`).'),
        time: timeArg.optional(),
        priority: priorityArg.optional(),
        repeat: repeatArg.optional(),
        note: z.string().optional().describe(`La nota donde va (id, título o ruta). Por defecto «${INBOX}».`),
        subtask_of: z.string().optional().describe('Id de la tarea de la que es subtarea (de list_tasks).'),
        profile: profileArg,
      },
    },
    run(({ text: source, due, start, time, priority, repeat, note, subtask_of, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const rule = repeat ? recurArg(repeat) : null;
      if (start && (!due || start > due)) throw new McpError('`start` necesita `due` y no puede ser después.');
      if (time && !due) throw new McpError('`time` necesita `due`.');
      // Lo que se repite necesita una fecha desde la que contar: hoy, si no se da otra.
      const item = newTaskItem(source, { startAt: start ?? null, ...(time ? timesOf(time) : {}), dueAt: due ?? (rule ? localDay() : null), priority: priority ? PRIORITY[priority] : 0, repeat: rule });
      let host: Note | undefined;
      let under: Task | undefined;
      if (subtask_of) {
        under = findTask(all, subtask_of);
        host = byId.get(under.noteId);
      } else if (note) host = textNote(resolveNote(all, note));
      else host = all.find((n) => !n.zoneId && n.kind === 'text' && !n.archivedAt && n.title?.trim().toLocaleLowerCase('es') === INBOX.toLocaleLowerCase('es'));
      let row: Note;
      if (host) {
        const doc = addTaskItem(host, item, under);
        linkWikis(db, p.id, host.id, doc);
        row = saveNote(db, host.id, contentOf(doc));
      } else {
        // Sin «Tareas» todavía: se crea, como hace la web.
        const title = { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: INBOX }] };
        const doc = { type: 'doc', content: [title, { type: 'taskList', content: [item] }] };
        row = createNote(db, p.id, { doc, parentId: null });
        linkWikis(db, p.id, row.id, doc);
        row = saveNote(db, row.id, contentOf(doc));
      }
      byId.set(row.id, row);
      changed();
      // La casilla nueva es la última de la nota o, si es subtarea, la última dentro de la otra.
      const after = allTasks([row]);
      let added = after[after.length - 1];
      if (under) {
        const inside = new Set([under.id]);
        for (const t of after) if (t.parentId && inside.has(t.parentId)) {
          inside.add(t.id);
          added = t;
        }
      }
      return data({ added: taskOut(byId, added) });
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Cambiar tarea',
      description:
        'Marca una tarea como hecha (o en curso, bloqueada, pendiente), le cambia la fecha, la prioridad, la repetición, las etiquetas o el texto. Hecha una tarea, se hacen sus subtareas; si se repite, se apunta la siguiente vez (sale en `next`).',
      inputSchema: {
        task: z.string().min(3).describe('Id de la tarea (de list_tasks o get_note).'),
        status: z.enum(STATUS).optional(),
        due: day.nullable().optional().describe('null quita la fecha.'),
        start: day.nullable().optional().describe('Si dura varios días, el día en que empieza (hasta `due`); null lo quita.'),
        time: timeArg.nullable().optional().describe('«09:30» o «09:30-11:00»; null la deja de todo el día.'),
        priority: priorityArg.optional(),
        repeat: repeatArg.nullable().optional().describe('null (o "") deja de repetirla.'),
        tags: z.array(z.string()).optional().describe('Las etiquetas que debe tener (sustituye las que tenía).'),
        text: z.string().trim().min(1).max(1000).optional().describe('Texto nuevo (sin fecha ni prioridad).'),
        profile: profileArg,
      },
    },
    run(({ task, status, due, start, time, priority, repeat, tags, text: source, profile }) => {
      const { profile: p, all, byId } = ctx(profile);
      const t = findTask(all, task);
      const row = byId.get(t.noteId)!;
      const rule = repeat === undefined ? undefined : repeat ? recurArg(repeat) : null;
      const change = {
        ...(status ? { status: status as TaskStatus } : {}),
        ...(due !== undefined ? { dueAt: due } : rule && !t.dueAt ? { dueAt: localDay() } : {}),
        ...(start !== undefined ? { startAt: start } : due === null && t.startAt ? { startAt: null } : {}),
        ...(time !== undefined ? (time ? timesOf(time) : { startTime: null }) : due === null && t.startTime ? { startTime: null } : {}),
        ...(rule !== undefined ? { repeat: rule } : {}),
        ...(priority ? { priority: PRIORITY[priority] } : {}),
        ...(tags ? { tags: tags.map((x) => x.replace(/^#/, '')) } : {}),
        ...(source !== undefined ? { source } : {}),
      };
      const s0 = 'startAt' in change ? change.startAt : t.startAt;
      const d0 = 'dueAt' in change ? change.dueAt : t.dueAt;
      if (s0 && (!d0 || s0 > d0)) throw new McpError('`start` necesita `due` y no puede ser después.');
      const again = recurs(t, change);
      const doc = changeTask(row, t, change);
      if (!doc) throw new McpError('Esa tarea ya no está en su nota.');
      linkWikis(db, p.id, row.id, doc);
      const saved = saveNote(db, row.id, contentOf(doc));
      byId.set(saved.id, saved);
      changed();
      const after = allTasks([saved]);
      // La siguiente vez queda encima: con su número, y la hecha en el siguiente.
      if (again) return data({ updated: taskOut(byId, after[t.n + 1]), next: taskOut(byId, after[t.n]) });
      return data({ updated: taskOut(byId, after[t.n]) });
    }),
  );

  // ── Resúmenes ───────────────────────────────────────────────────────

  server.registerTool(
    'recent_activity',
    {
      title: 'Actividad reciente',
      description: 'Qué se ha tocado en los últimos días: notas creadas y editadas, tareas hechas y tareas que vencen. Útil para resúmenes semanales.',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('Por defecto 7.'),
        profile: profileArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(({ days = 7, profile }) => {
      const { all, byId } = ctx(profile);
      const today = localDay();
      const since = addDays(today, -days + 1);
      const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
      const hidden = hiddenIds(all);
      const visible = all.filter((n) => !hidden.has(n.id));
      const created = visible.filter((n) => n.createdAt >= sinceIso).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const edited = visible
        .filter((n) => n.updatedAt >= sinceIso && n.createdAt < sinceIso)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const tasks = listedTasks(visible);
      const done = tasks.filter((t) => t.status === 'done' && t.doneAt && t.doneAt >= since);
      const overdue = tasks.filter((t) => t.status !== 'done' && t.dueAt && t.dueAt < today);
      const dueSoon = tasks.filter((t) => t.status !== 'done' && t.dueAt && t.dueAt >= today && t.dueAt <= addDays(today, 7));
      const archived = all.filter((n) => n.archivedAt && n.archivedAt >= sinceIso);
      return data({
        period: { from: since, to: today },
        created: created.slice(0, 100).map((n) => brief(byId, n)),
        edited: edited.slice(0, 100).map((n) => brief(byId, n)),
        tasksDone: done.map((t) => taskOut(byId, t)),
        tasksOverdue: overdue.map((t) => taskOut(byId, t)),
        tasksDueNext7Days: dueSoon.map((t) => taskOut(byId, t)),
        ...(archived.length ? { archived: archived.map((n) => brief(byId, n)) } : {}),
      });
    }),
  );

  return server;
}

// «nota:n» → la tarea (comprobando que la nota sigue ahí y la tiene).
function findTask(all: Note[], id: string): Task {
  const at = id.lastIndexOf(':');
  const noteId = id.slice(0, at);
  const n = Number(id.slice(at + 1));
  const row = all.find((x) => x.id === noteId);
  const task = row && Number.isInteger(n) ? allTasks([row])[n] : undefined;
  if (!task) throw new McpError(`No encuentro la tarea ${id}. Vuelve a listarlas con list_tasks: los ids cambian si se edita la nota.`);
  return task;
}
