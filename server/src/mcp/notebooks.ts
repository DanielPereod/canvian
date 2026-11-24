import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { nbTopics, notebooks } from '../db/schema.js';
import { addCards, dueCards, grade, list, masteryOf, sourcesFor, suggestNext, topicsOf, touch, type Notebook, type Topic } from '../notebooks/model.js';
import { studyPrompt } from '../notebooks/tutor.js';
import { McpError, resolveProfile } from './notes.js';

// Los cuadernos desde la app de Claude (o cualquier cliente MCP): estudiar un
// tema con las mismas reglas del tutor, guardar lo aprendido y repasar.

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const data = (value: unknown) => text(JSON.stringify(value, null, 2));
const fold = (s: string) => s.trim().toLocaleLowerCase();
const profileArg = z.string().optional().describe('Perfil (nombre o id). Por defecto, el primero.');

export function registerNotebookTools(server: McpServer, db: Db, changed: () => void) {
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

  const findNotebook = (ref: string, profile?: string): Notebook => {
    const p = resolveProfile(db, profile);
    const all = db.select().from(notebooks).where(eq(notebooks.profileId, p.id)).orderBy(asc(notebooks.position)).all();
    const hit = all.find((n) => n.id === ref) ?? all.find((n) => fold(n.title) === fold(ref)) ?? all.find((n) => fold(n.title).includes(fold(ref)));
    if (!hit) throw new McpError(`No hay ningún cuaderno «${ref}». Cuadernos: ${all.map((n) => n.title).join(', ') || '(ninguno)'}.`);
    return hit;
  };
  const findTopic = (nb: Notebook, ref?: string): Topic => {
    const topics = topicsOf(db, nb.id);
    if (!topics.length) throw new McpError(`«${nb.title}» aún no tiene temario: créalo desde Canvian (Cuadernos).`);
    if (!ref) {
      const next = suggestNext(topics, masteryOf(db, nb.id));
      return topics.find((t) => t.id === next) ?? topics[0];
    }
    const hit = topics.find((t) => t.id === ref) ?? topics.find((t) => fold(t.title) === fold(ref)) ?? topics.find((t) => fold(t.title).includes(fold(ref)));
    if (!hit) throw new McpError(`«${nb.title}» no tiene el tema «${ref}». Temas: ${topics.map((t) => t.title).join(', ')}.`);
    return hit;
  };
  const topicById = (id: string): Topic => {
    const t = db.select().from(nbTopics).where(eq(nbTopics.id, id)).get();
    if (!t) throw new McpError('Tema no encontrado: usa el id que da get_notebook.');
    return t;
  };

  server.registerTool(
    'list_notebooks',
    { title: 'Cuadernos', description: 'Los cuadernos de aprendizaje (Cuadernos en Canvian): cada uno una materia con su temario, su repaso espaciado y su mapa de dominio.', inputSchema: { profile: profileArg }, annotations: { readOnlyHint: true } },
    run(({ profile }) => {
      const p = resolveProfile(db, profile);
      const all = db.select().from(notebooks).where(eq(notebooks.profileId, p.id)).orderBy(asc(notebooks.position)).all();
      return data(
        all.map((nb) => {
          const topics = topicsOf(db, nb.id);
          const next = suggestNext(topics, masteryOf(db, nb.id));
          return { id: nb.id, title: nb.title, goal: nb.goal, topics: topics.length, done: topics.filter((t) => t.status === 'hecho').length, next: topics.find((t) => t.id === next)?.title ?? null, due: dueCards(db, [nb.id]).length };
        }),
      );
    }),
  );

  server.registerTool(
    'get_notebook',
    {
      title: 'Leer cuaderno',
      description: 'El temario de un cuaderno con el estado de cada tema (dominio según el repaso, huecos, lo que ya está claro) y sus fuentes.',
      inputSchema: { notebook: z.string().min(1).describe('El cuaderno: su id o su título.'), profile: profileArg },
      annotations: { readOnlyHint: true },
    },
    run(({ notebook, profile }) => {
      const nb = findNotebook(notebook, profile);
      const mastery = masteryOf(db, nb.id);
      const topics = topicsOf(db, nb.id);
      return data({
        id: nb.id,
        title: nb.title,
        goal: nb.goal,
        level: nb.level,
        next: suggestNext(topics, mastery),
        topics: topics.map((t) => ({ id: t.id, title: t.title, summary: t.summary, status: t.status, mastery: mastery[t.id]?.level, gaps: list(t.gaps), solid: list(t.solid), sources: sourcesFor(db, nb.id, t.id).map((s) => ({ title: s.title, url: s.url })) })),
      });
    }),
  );

  const studyArgs = { notebook: z.string().min(1).describe('El cuaderno: su id o su título.'), topic: z.string().optional().describe('El tema (id o título). Sin él, el siguiente que toca.'), profile: profileArg };
  server.registerTool(
    'study_topic',
    {
      title: 'Estudiar un tema',
      description: 'Prepara una sesión guiada de un tema del cuaderno: devuelve las reglas del tutor, el contexto y las fuentes. Síguelas al pie de la letra durante la conversación.',
      inputSchema: studyArgs,
      annotations: { readOnlyHint: true },
    },
    run(({ notebook, topic, profile }) => {
      const nb = findNotebook(notebook, profile);
      const t = findTopic(nb, topic);
      return text(`(id del tema: ${t.id})\n\n${studyPrompt(nb, topicsOf(db, nb.id), t, sourcesFor(db, nb.id, t.id))}`);
    }),
  );
  server.registerPrompt(
    'estudiar_tema',
    { title: 'Estudiar un tema de un cuaderno', description: 'Sesión guiada con el tutor de Canvian.', argsSchema: { notebook: z.string().describe('El cuaderno (título)'), topic: z.string().optional().describe('El tema (vacío: el siguiente)') } },
    ({ notebook, topic }) => {
      const nb = findNotebook(notebook);
      const t = findTopic(nb, topic || undefined);
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `(id del tema: ${t.id})\n\n${studyPrompt(nb, topicsOf(db, nb.id), t, sourcesFor(db, nb.id, t.id))}` } }] };
    },
  );

  server.registerTool(
    'save_topic_progress',
    {
      title: 'Guardar progreso del tema',
      description: 'Guarda cómo va un tema tras estudiarlo: los huecos que quedan, lo que ya está claro, la página de la lección para releer (Markdown) y si está hecho.',
      inputSchema: {
        topic: z.string().min(1).describe('El id del tema (de get_notebook o study_topic).'),
        gaps: z.array(z.string()).optional(),
        solid: z.array(z.string()).optional(),
        lesson: z.string().max(40_000).optional(),
        status: z.enum(['pendiente', 'estudiando', 'hecho']).optional(),
      },
    },
    run(({ topic, gaps, solid, lesson, status }) => {
      const t = topicById(topic);
      db.update(nbTopics)
        .set({
          ...(gaps ? { gaps: JSON.stringify(gaps.slice(0, 20)) } : {}),
          ...(solid ? { solid: JSON.stringify(solid.slice(0, 20)) } : {}),
          ...(lesson !== undefined ? { lesson } : {}),
          ...(status ? { status } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(nbTopics.id, t.id))
        .run();
      touch(db, t.notebookId);
      changed();
      return text(`Guardado el progreso de «${t.title}».`);
    }),
  );

  server.registerTool(
    'add_notebook_cards',
    {
      title: 'Crear tarjetas de repaso',
      description: 'Añade tarjetas al repaso espaciado (FSRS) de un tema. Una idea por tarjeta; preguntas que obliguen a recordar. kind: dato (pregunta corta), explica (pide un porqué) o problema (ejercicio con su solución).',
      inputSchema: {
        topic: z.string().min(1).describe('El id del tema.'),
        cards: z.array(z.object({ kind: z.enum(['dato', 'explica', 'problema']).optional(), front: z.string().min(1), back: z.string().min(1) })).min(1).max(30),
      },
    },
    run(({ topic, cards }) => {
      const t = topicById(topic);
      const rows = addCards(db, t.notebookId, t.id, cards);
      changed();
      return text(`${rows.length} tarjetas nuevas en «${t.title}».`);
    }),
  );

  server.registerTool(
    'due_cards',
    {
      title: 'Tarjetas para repasar',
      description: 'Las tarjetas que tocan hoy, mezcladas entre temas. Para repasar en la conversación: enseña la pregunta, deja que la persona responda, enseña la respuesta y pregúntale qué tal le ha ido (1 otra vez, 2 difícil, 3 bien, 4 fácil); luego llama a grade_card.',
      inputSchema: { notebook: z.string().optional().describe('Solo de este cuaderno (id o título).'), limit: z.number().int().min(1).max(50).optional(), profile: profileArg },
      annotations: { readOnlyHint: true },
    },
    run(({ notebook, limit = 15, profile }) => {
      const p = resolveProfile(db, profile);
      const ids = notebook ? [findNotebook(notebook, profile).id] : db.select({ id: notebooks.id }).from(notebooks).where(and(eq(notebooks.profileId, p.id))).all().map((n) => n.id);
      return data(dueCards(db, ids).slice(0, limit).map((c) => ({ id: c.id, kind: c.kind, front: c.front, back: c.back })));
    }),
  );

  server.registerTool(
    'grade_card',
    {
      title: 'Puntuar tarjeta',
      description: 'Apunta cómo ha ido una tarjeta en el repaso: 1 otra vez, 2 difícil, 3 bien, 4 fácil. FSRS decide cuándo vuelve.',
      inputSchema: { card: z.string().min(1), rating: z.number().int().min(1).max(4) },
    },
    run(({ card, rating }) => {
      try {
        const saved = grade(db, card, rating);
        changed();
        return text(`Vuelve el ${saved.due.slice(0, 10)}.`);
      } catch (e) {
        throw new McpError(e instanceof Error ? e.message : String(e));
      }
    }),
  );

}
