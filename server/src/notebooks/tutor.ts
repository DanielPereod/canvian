import type { Ai } from '../ai/claude.js';
import { list, type Message, type Notebook, type Source, type Topic } from './model.js';

// Lo que se le pide a la IA en los cuadernos. Las reglas del tutor salen de la
// investigación sobre cómo se aprende (ver la página de diseño «Cuadernos»):
// intentar antes de que te expliquen (pretesting), bloques cortos con una
// pregunta después de cada uno (recuperación intercalada), ejemplos resueltos
// que se van quitando, problemas sin ayuda con pistas graduadas, explicar el
// porqué (autoexplicación) y escribir lo aprendido con tus palabras.

export const STAGES = ['entrada', 'idea', 'ejemplo', 'comprueba', 'intenta', 'socratico', 'nota', 'fin'] as const;
export type Stage = (typeof STAGES)[number];

const RULES = `Eres el tutor de Canvian, la app de notas de la persona. Enseñas en español, de tú, con frases claras y cortas.
Tu trabajo es que la persona aprenda de verdad, no que sienta que aprende. Reglas, sin excepción:
1. Pregunta antes de explicar. Empieza cada tema con un problema o pregunta que aún no sabe responder y pídele que lo intente aunque falle.
2. Explica en bloques cortos (3–6 frases). Después de cada bloque haz una pregunta de comprobación y espera la respuesta antes de seguir.
3. Usa ejemplos resueltos paso a paso al principio y quítalos poco a poco a medida que acierta.
4. En los problemas, no des la solución: primero una pista pequeña; si vuelve a fallar, otra más concreta; la solución solo tras dos intentos o si la pide de forma explícita.
5. Pídele que explique el porqué con sus palabras, que ponga un ejemplo propio y qué pasaría si algo cambiara.
6. Si una respuesta es incorrecta, dilo con claridad y amabilidad, sin rodeos, y explica dónde está el fallo.
7. Nunca escribes por la persona sus notas ni sus explicaciones.
8. Apóyate en las fuentes y apuntes que se te dan, y di de cuál sale una idea cuando venga de una. Si algo no está en ellas, puedes enseñarlo, pero no inventes datos, citas ni referencias. Si la persona dice que algo no le cuadra, revísalo con cuidado y corrige si te equivocaste.
9. Una sola pregunta por mensaje. Nada de listas largas ni de párrafos de relleno.
10. Escribe en Markdown sencillo. Para fórmulas usa texto plano o \`código\`.`;

const nbContext = (nb: Notebook, topics: Topic[]) =>
  [
    `Cuaderno: «${nb.title}».`,
    nb.goal ? `Para qué lo quiere: ${nb.goal}` : '',
    nb.level ? `Punto de partida: ${nb.level}` : '',
    topics.length ? `Temario:\n${topics.map((t, i) => `${i + 1}. ${t.title}${t.status === 'hecho' ? ' (hecho)' : ''}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

const sourceLine = (s: Source) => `- ${s.title}${s.url ? ` (${s.url})` : ''}${s.kind === 'nota' ? ' [nota de su biblioteca]' : ''}`;

const strings = { type: 'array', items: { type: 'string' } };

export async function diagnosis(ai: Ai, nb: Notebook) {
  const res = await ai.ask({
    system: RULES,
    prompt: `${nbContext(nb, [])}

Antes de preparar el temario quieres saber de dónde parte. Escribe entre 4 y 6 preguntas cortas de diagnóstico: qué sabe ya (con alguna pregunta concreta del tema que permita ver su nivel real, no solo «¿sabes X?»), para qué lo quiere y cuánto tiempo puede dedicarle.`,
    schema: { type: 'object', properties: { questions: strings }, required: ['questions'], additionalProperties: false },
  });
  return (res.json as { questions: string[] }).questions.slice(0, 8);
}

export async function plan(ai: Ai, nb: Notebook, answers: { q: string; a: string }[]) {
  const res = await ai.ask({
    system: RULES,
    prompt: `${nbContext(nb, [])}

Respuestas del diagnóstico:
${answers.map((x) => `- ${x.q}\n  → ${x.a || '(sin responder)'}`).join('\n')}

Prepara el temario: entre 5 y 12 temas en el orden en que conviene aprenderlos, desde su punto de partida. Cada tema con un título corto, un resumen de una frase y de qué temas anteriores depende (por su número, empezando en 0). Resume también su punto de partida en una frase.`,
    schema: {
      type: 'object',
      properties: {
        level: { type: 'string' },
        topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, summary: { type: 'string' }, depends_on: { type: 'array', items: { type: 'integer' } } },
            required: ['title', 'summary', 'depends_on'],
            additionalProperties: false,
          },
        },
      },
      required: ['level', 'topics'],
      additionalProperties: false,
    },
  });
  const out = res.json as { level: string; topics: { title: string; summary: string; depends_on: number[] }[] };
  return { level: out.level, topics: out.topics.slice(0, 20).map((t) => ({ title: t.title, summary: t.summary, dependsOn: t.depends_on })) };
}

export type NoteCandidate = { id: string; title: string; text: string };

/** Busca fuentes buenas (y elige de entre sus notas las que sirven) y saca apuntes de ellas. */
export async function findSources(
  ai: Ai,
  nb: Notebook,
  topic: Topic | null,
  opts: { keep: Source[]; removed: Source[]; notes: NoteCandidate[]; search: boolean },
) {
  const what = topic ? `el tema «${topic.title}»${topic.summary ? ` (${topic.summary})` : ''}` : `el cuaderno entero`;
  const res = await ai.ask({
    system: RULES,
    web: true,
    prompt: `${nbContext(nb, [])}

Elige las fuentes para aprender ${what}.
${opts.search ? 'Busca en internet 2–4 fuentes nuevas de calidad, abiertas y en lo posible gratuitas (manuales abiertos, apuntes universitarios, artículos de referencia, vídeos de divulgadores serios). Comprueba que el enlace existe. Prefiere español, pero vale inglés si es mucho mejor.' : 'No busques fuentes nuevas: la persona solo quiere usar las suyas.'}
${opts.keep.length ? `Fuentes que ya tiene (no las repitas; léelas si son páginas web):\n${opts.keep.map(sourceLine).join('\n')}` : ''}
${opts.removed.length ? `Fuentes que la persona quitó: no las propongas otra vez.\n${opts.removed.map(sourceLine).join('\n')}` : ''}
${opts.notes.length ? `Notas de su biblioteca que podrían servir (elige solo las que de verdad traten el tema, por su id):\n${opts.notes.map((n) => `- id ${n.id}: «${n.title}» — ${n.text.slice(0, 300).replace(/\s+/g, ' ')}`).join('\n')}` : ''}

Después escribe unos apuntes del tema sacados de las fuentes (las que ya tiene y las nuevas): las ideas clave, definiciones y ejemplos, en Markdown, diciendo entre corchetes de qué fuente sale cada cosa. Máximo 600 palabras. El tutor se apoyará en ellos.`,
    schema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['web', 'video', 'libro', 'pdf'] }, title: { type: 'string' }, url: { type: 'string' }, why: { type: 'string' } },
            required: ['kind', 'title', 'url', 'why'],
            additionalProperties: false,
          },
        },
        note_ids: strings,
        brief: { type: 'string' },
      },
      required: ['sources', 'note_ids', 'brief'],
      additionalProperties: false,
    },
  });
  const out = res.json as { sources: { kind: string; title: string; url: string; why: string }[]; note_ids: string[]; brief: string };
  return { sources: opts.search ? out.sources.slice(0, 6) : [], noteIds: out.note_ids.filter((id) => opts.notes.some((n) => n.id === id)), brief: out.brief };
}

const transcript = (msgs: Message[]) =>
  msgs.length ? msgs.map((m) => `${m.role === 'tutor' ? 'TUTOR' : 'PERSONA'}${m.stage ? ` [${m.stage}]` : ''}: ${m.body}`).join('\n\n') : '(aún no habéis empezado)';

export type TurnOut = { message: string; stage: Stage; gaps: string[]; solid: string[] };

/** El siguiente mensaje del tutor en la sesión guiada de un tema. */
export async function turn(ai: Ai, nb: Notebook, topics: Topic[], topic: Topic, sources: Source[], msgs: Message[], noteBodies: Record<string, string>): Promise<TurnOut> {
  const done = topics.filter((t) => t.status === 'hecho' && t.id !== topic.id);
  const res = await ai.ask({
    system: RULES,
    prompt: `${nbContext(nb, topics)}

Tema de hoy: «${topic.title}»${topic.summary ? ` — ${topic.summary}` : ''}.
${done.length ? `Ya ha estudiado: ${done.map((t) => t.title).join(', ')}.` : ''}
${sources.length ? `Fuentes del tema:\n${sources.map(sourceLine).join('\n')}` : 'No hay fuentes elegidas: enseña con cuidado de no inventar referencias.'}
${topic.brief ? `\nApuntes de las fuentes:\n${topic.brief}` : ''}
${Object.entries(noteBodies).map(([title, body]) => `\nNota suya «${title}»:\n${body.slice(0, 3000)}`).join('\n')}
${list(topic.gaps).length ? `\nHuecos detectados hasta ahora: ${list(topic.gaps).join('; ')}` : ''}

La sesión va por etapas: entrada (pregunta de entrada que intenta sin saber) → idea (bloque corto) → ejemplo (resuelto) → comprueba (pregunta tras el bloque) → [más ideas, ejemplos y comprobaciones hasta cubrir el tema, en 2–4 bloques] → intenta (2–3 problemas sin ayuda, con pistas si falla) → socratico (que explique el porqué, un ejemplo propio y un «qué pasaría si») → nota (pídele que escriba su nota con lo aprendido, con sus palabras y sin mirar, en el editor de notas que Canvian le abre al lado: ahí elige dónde guardarla. No la pegue en el chat. Si aun así la escribe en el chat, dile que la pase al editor para que se guarde y la revises) → fin.
No pases a la siguiente etapa hasta que la anterior esté bien resuelta. Si falla una comprobación, vuelve a explicar ese punto de otra manera.

Conversación hasta ahora:
${transcript(msgs)}

Escribe tu siguiente mensaje como tutor. Devuelve también la etapa de ese mensaje, la lista actualizada de huecos (lo que aún no domina o ha fallado, en pocas palabras cada uno) y de lo que ya tiene claro.`,
    schema: {
      type: 'object',
      properties: { message: { type: 'string' }, stage: { type: 'string', enum: [...STAGES] }, gaps: strings, solid: strings },
      required: ['message', 'stage', 'gaps', 'solid'],
      additionalProperties: false,
    },
  });
  const out = res.json as TurnOut;
  return { message: out.message.trim(), stage: (STAGES as readonly string[]).includes(out.stage) ? out.stage : 'idea', gaps: out.gaps.slice(0, 20), solid: out.solid.slice(0, 20) };
}

export type Review = {
  covered: { idea: string; ok: boolean }[];
  question: string;
  links: string[];
  lesson: string;
  cards: { kind: 'dato' | 'explica' | 'problema'; front: string; back: string }[];
};

/** Lee la nota que ha escrito la persona y prepara la página para releer y las tarjetas. */
export async function reviewNote(ai: Ai, nb: Notebook, topic: Topic, msgs: Message[], note: string, library: string[]): Promise<Review> {
  const res = await ai.ask({
    system: RULES,
    prompt: `${nbContext(nb, [])}

Tema: «${topic.title}».
Sesión con el tutor:
${transcript(msgs)}

${list(topic.gaps).length ? `Huecos que quedaron: ${list(topic.gaps).join('; ')}` : ''}

La persona ha escrito esta nota con lo que ha aprendido, sin mirar:
<<<
${note}
>>>

1. Haz la lista de las ideas clave del tema y marca si su nota las cubre bien (ok) o no.
2. Si falta algo importante o hay un error, escribe UNA pregunta que la lleve a darse cuenta (no le des la respuesta ni le reescribas la nota). Si está completa y bien, felicítala en una frase.
3. De estas notas de su biblioteca, elige hasta 3 con las que conecta de verdad (sus títulos exactos), o ninguna: ${library.slice(0, 80).map((t) => `«${t}»`).join(', ') || '(no hay)'}.
4. Escribe la página de la lección para releer: lo que se vio en la sesión, ordenado y claro, en Markdown, con los ejemplos resueltos. Máximo 700 palabras.
5. Propón entre 4 y 10 tarjetas de repaso, sobre todo de los huecos y de lo que le costó: «dato» (pregunta y respuesta cortas), «explica» (pide explicar un porqué) o «problema» (un ejercicio nuevo con su solución). Una idea por tarjeta, preguntas que obliguen a recordar, no a reconocer.`,
    schema: {
      type: 'object',
      properties: {
        covered: { type: 'array', items: { type: 'object', properties: { idea: { type: 'string' }, ok: { type: 'boolean' } }, required: ['idea', 'ok'], additionalProperties: false } },
        question: { type: 'string' },
        links: strings,
        lesson: { type: 'string' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['dato', 'explica', 'problema'] }, front: { type: 'string' }, back: { type: 'string' } },
            required: ['kind', 'front', 'back'],
            additionalProperties: false,
          },
        },
      },
      required: ['covered', 'question', 'links', 'lesson', 'cards'],
      additionalProperties: false,
    },
  });
  const out = res.json as Review;
  return { ...out, links: out.links.filter((t) => library.includes(t)).slice(0, 3), cards: out.cards.slice(0, 12) };
}

/** Prompt del MCP para estudiar un tema desde la app de Claude con las mismas reglas. */
export function studyPrompt(nb: Notebook, topics: Topic[], topic: Topic, sources: Source[]) {
  return `${RULES}

${nbContext(nb, topics)}

Vamos a estudiar «${topic.title}»${topic.summary ? ` (${topic.summary})` : ''} en una sesión guiada: pregunta de entrada, bloques cortos con comprobación, problemas con pistas, preguntas socráticas y, al final, que escriba su nota.
${sources.length ? `Fuentes:\n${sources.map(sourceLine).join('\n')}` : ''}
${topic.brief ? `\nApuntes de las fuentes:\n${topic.brief}` : ''}

Al terminar, guarda el progreso en Canvian con la herramienta save_topic_progress (huecos, lo que tiene claro y la página de la lección) y crea las tarjetas con add_notebook_cards. Empieza ya con la pregunta de entrada.`;
}
