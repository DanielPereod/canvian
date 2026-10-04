import { parseBody, titleFrom, type JSONContent } from './json.js';
import { docText, inlineFromMd, inlineToMd } from './markdown.js';

// Las tareas no son notas: son las casillas «- [ ]» que hay dentro de las
// notas, y una casilla sangrada bajo otra es su subtarea. Aquí se leen del
// documento de cada nota y se cambian en él.
//
// Lo que no es la casilla va escrito en la propia línea, como en Obsidian:
//   - [ ] Llamar al banco #casa 📅 2026-10-02 ⏫ ✅ 2026-10-01
// «📅» es la fecha, «⏫ 🔼 🔽» la prioridad (alta, media, baja), «✅» cuándo se
// hizo y «#palabra» una etiqueta. «[/]» es en curso y «[!]» bloqueada.

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
/** Lo que hace falta de una nota para leer y cambiar sus tareas. */
export type NoteRow = { id: string; kind: string; bodyJson: string | null; updatedAt: string };

export type Task = {
  /** `${nota}:${n}`: la n-ésima casilla de la nota, en orden. */
  id: string;
  noteId: string;
  n: number;
  /** El texto, sin fecha, prioridad ni etiquetas. */
  title: string;
  /** Lo mismo en Markdown (con sus negritas y [[enlaces]]), para editarlo. */
  source: string;
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
  doneAt: string | null;
  tags: string[];
  /** La tarea de la que es subtarea (o null). */
  parentId: string | null;
  depth: number;
  kids: string[];
  updatedAt: string;
};

export type TaskChange = {
  status?: TaskStatus;
  priority?: number;
  dueAt?: string | null;
  tags?: string[];
  /** Texto nuevo, en Markdown (sin fecha ni prioridad). */
  source?: string;
};

// ── Lo escrito en la línea ────────────────────────────────────────────
const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
const DUE = new RegExp(String.raw`\s*📅️?\s*${DATE}`, 'gu');
const DONE = new RegExp(String.raw`\s*✅️?\s*${DATE}`, 'gu');
const PRIO = /\s*(🔺|⏫|🔼|🔽|⏬)️?/gu;
const TAG = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
const PRIO_OF: Record<string, number> = { '🔺': 3, '⏫': 3, '🔼': 2, '🔽': 1, '⏬': 1 };
export const PRIO_MARK = ['', '🔽', '🔼', '⏫'];

const first = (re: RegExp, text: string) => {
  re.lastIndex = 0;
  return re.exec(text);
};
const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();
// El texto sin fecha, prioridad, etiquetas ni «hecha el».
const bare = (text: string) => tidy(text.replace(DUE, '').replace(DONE, '').replace(PRIO, '').replace(TAG, '$1'));

function tagsIn(text: string) {
  const out: string[] = [];
  for (const m of text.matchAll(TAG)) if (!out.some((t) => t.toLowerCase() === m[2].toLowerCase())) out.push(m[2]);
  return out;
}

// El texto plano de un párrafo, con los [[enlaces]] por su nombre.
const plain = (content: JSONContent[] | undefined) =>
  (content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'wikilink' ? String(c.attrs?.alias || c.attrs?.target || '') : c.type === 'hardBreak' ? ' ' : '')).join('');

// ── Leer ──────────────────────────────────────────────────────────────
const cache = new Map<string, Task[]>();

/** Las tareas de una nota, en el orden en que están escritas. */
export function tasksOf(row: NoteRow): Task[] {
  if (row.kind === 'canvas' || !row.bodyJson || !row.bodyJson.includes('"taskItem"')) return [];
  const key = `${row.id}\u0000${row.updatedAt}\u0000${row.bodyJson}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: Task[] = [];
  const doc = parseBody(row.bodyJson);
  const walk = (node: JSONContent, parent: Task | null, depth: number) => {
    for (const child of node.content ?? []) {
      if (child.type !== 'taskItem') {
        walk(child, parent, depth);
        continue;
      }
      const para = child.content?.[0];
      const text = plain(para?.type === 'paragraph' ? para.content : []);
      const checked = !!child.attrs?.checked;
      const status: TaskStatus = checked ? 'done' : child.attrs?.status === 'doing' ? 'doing' : child.attrs?.status === 'blocked' ? 'blocked' : 'todo';
      const tags = tagsIn(text);
      const task: Task = {
        id: `${row.id}:${out.length}`,
        noteId: row.id,
        n: out.length,
        title: bare(text),
        source: bare(inlineToMd(para?.type === 'paragraph' ? para.content : [])),
        status,
        priority: PRIO_OF[first(PRIO, text)?.[1] ?? ''] ?? 0,
        dueAt: first(DUE, text)?.[1] ?? null,
        doneAt: checked ? (first(DONE, text)?.[1] ?? null) : null,
        tags,
        parentId: parent?.id ?? null,
        depth,
        kids: [],
        updatedAt: row.updatedAt,
      };
      parent?.kids.push(task.id);
      out.push(task);
      walk({ content: child.content?.slice(1) }, task, depth + 1);
    }
  };
  if (doc) walk(doc, null, 0);
  if (cache.size > 4000) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

export const allTasks = (rows: NoteRow[]) => rows.flatMap(tasksOf);

// ── Cambiar ───────────────────────────────────────────────────────────
const clone = (doc: JSONContent): JSONContent => JSON.parse(JSON.stringify(doc)) as JSONContent;
const emptyDoc = (): JSONContent => ({ type: 'doc', content: [] });

// La n-ésima casilla del documento, con la lista que la contiene.
function locate(doc: JSONContent, n: number): { item: JSONContent; list: JSONContent; index: number } | null {
  let seen = 0;
  let found: { item: JSONContent; list: JSONContent; index: number } | null = null;
  const walk = (node: JSONContent) => {
    (node.content ?? []).forEach((child, index) => {
      if (found) return;
      if (child.type === 'taskItem' && seen++ === n) found = { item: child, list: node, index };
      else walk(child);
    });
  };
  walk(doc);
  return found;
}

// Quita de los textos del párrafo lo que case con `re` (sin tocar sus marcas).
function stripNodes(content: JSONContent[], re: RegExp): JSONContent[] {
  return content
    .map((c) => (c.type === 'text' && c.text ? { ...c, text: c.text.replace(re, '') } : c))
    .filter((c) => c.type !== 'text' || c.text);
}
// Añade texto al final del párrafo, sin marcas.
function appendText(content: JSONContent[], text: string): JSONContent[] {
  const out = [...content];
  const last = out[out.length - 1];
  if (last?.type === 'text' && !last.marks?.length) out[out.length - 1] = { ...last, text: (last.text ?? '').replace(/\s+$/, '') + text };
  else out.push({ type: 'text', text: out.length ? text : text.trimStart() });
  return out;
}

// Hoy, en la hora local: la del navegador o, en el servidor, la de su zona (TZ).
let today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function setToday(fn: () => string) {
  today = fn;
}

// «#a #b 📅 … ⏫ ✅ …»: lo que va detrás del texto al escribir una tarea entera.
function tail(t: { tags: string[]; dueAt?: string | null; priority?: number; doneAt?: string | null }) {
  return [...t.tags.map((x) => `#${x}`), t.dueAt ? `📅 ${t.dueAt}` : '', PRIO_MARK[t.priority ?? 0], t.doneAt ? `✅ ${t.doneAt}` : ''].filter(Boolean).join(' ');
}

function paragraphOf(source: string, meta: Parameters<typeof tail>[0]): JSONContent {
  const t = tail(meta);
  let content = inlineFromMd(tidy(source));
  if (t) content = appendText(content, ` ${t}`);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

// Hecha una tarea, hechas sus subtareas (las que faltaban, con la fecha de hoy).
function finishKids(nodes: JSONContent[]) {
  for (const n of nodes) {
    if (n.type === 'taskItem' && !n.attrs?.checked) {
      const { status: _old, ...attrs } = n.attrs ?? {};
      n.attrs = { ...attrs, checked: true };
      const para = n.content?.[0];
      if (para?.type === 'paragraph') para.content = appendText(stripNodes(para.content ?? [], DONE), ` ✅ ${today()}`);
    }
    finishKids(n.content ?? []);
  }
}

function changeItem(item: JSONContent, task: Task, change: TaskChange) {
  const rest = (item.content ?? []).slice(1);
  if (change.status === 'done' && task.status !== 'done') finishKids(rest);
  if (change.status) {
    const { status: _old, ...attrs } = item.attrs ?? {};
    item.attrs = { ...attrs, checked: change.status === 'done', ...(change.status === 'doing' || change.status === 'blocked' ? { status: change.status } : {}) };
  }
  const done = (change.status ?? task.status) === 'done';
  // Texto nuevo: la línea se escribe entera, con lo que ya tenía detrás.
  if (change.source !== undefined) {
    const typed = new Set(tagsIn(change.source).map((t) => t.toLowerCase()));
    const meta = {
      tags: (change.tags ?? task.tags).filter((t) => !typed.has(t.toLowerCase())),
      dueAt: change.dueAt !== undefined ? change.dueAt : task.dueAt,
      priority: change.priority ?? task.priority,
      doneAt: done ? (task.doneAt ?? today()) : null,
    };
    item.content = [paragraphOf(change.source, meta), ...rest];
    return;
  }
  // Si no, solo se toca lo que cambia, sin mover el resto de la línea.
  const para = item.content?.[0]?.type === 'paragraph' ? item.content[0] : { type: 'paragraph' };
  let content = [...(para.content ?? [])];
  if (change.status && done !== (task.status === 'done')) {
    content = stripNodes(content, DONE);
    if (done) content = appendText(content, ` ✅ ${today()}`);
  }
  if (change.dueAt !== undefined) {
    content = stripNodes(content, DUE);
    if (change.dueAt) content = appendText(content, ` 📅 ${change.dueAt.slice(0, 10)}`);
  }
  if (change.priority !== undefined) {
    content = stripNodes(content, PRIO);
    if (change.priority) content = appendText(content, ` ${PRIO_MARK[change.priority]}`);
  }
  if (change.tags) {
    const want = new Set(change.tags.map((t) => t.toLowerCase()));
    const had = new Set(task.tags.map((t) => t.toLowerCase()));
    content = content
      .map((c) => {
        if (c.type !== 'text' || !c.text) return c;
        const text = c.text.replace(TAG, (m, pre: string, tag: string) => (want.has(tag.toLowerCase()) ? m : pre));
        return text === c.text ? c : { ...c, text: text.replace(/ {2,}/g, ' ') };
      })
      .filter((c) => c.type !== 'text' || c.text);
    const added = change.tags.filter((t) => !had.has(t.toLowerCase()));
    if (added.length) content = appendText(content, ` ${added.map((t) => `#${t.replace(/[^\p{L}\p{N}_-]+/gu, '-')}`).join(' ')}`);
  }
  if (content[0]?.type === 'text') content[0] = { ...content[0], text: (content[0].text ?? '').trimStart() };
  content = content.filter((c) => c.type !== 'text' || c.text);
  item.content = [content.length ? { ...para, content } : { type: 'paragraph' }, ...rest];
}

/** El documento con la tarea cambiada (o null si ya no está). */
export function changeTask(row: NoteRow, task: Task, change: TaskChange): JSONContent | null {
  const doc = parseBody(row.bodyJson);
  if (!doc) return null;
  const next = clone(doc);
  const at = locate(next, task.n);
  if (!at) return null;
  changeItem(at.item, task, change);
  return next;
}

// Quita la casilla (con sus subtareas); una lista que se queda vacía, también.
function cut(doc: JSONContent, n: number): JSONContent | null {
  const at = locate(doc, n);
  if (!at) return null;
  at.list.content!.splice(at.index, 1);
  const prune = (node: JSONContent) => {
    if (!node.content) return;
    node.content = node.content.filter((c) => !(c.type === 'taskList' && !c.content?.length));
    for (const c of node.content) prune(c);
    // Un punto sin su párrafo no es válido: se le devuelve uno vacío.
    if ((node.type === 'taskItem' || node.type === 'listItem') && node.content[0]?.type !== 'paragraph') node.content.unshift({ type: 'paragraph' });
  };
  prune(doc);
  return at.item;
}

/** El documento sin la tarea (ni sus subtareas). */
export function removeTask(row: NoteRow, task: Task): JSONContent | null {
  const doc = parseBody(row.bodyJson);
  if (!doc) return null;
  const next = clone(doc);
  return cut(next, task.n) ? next : null;
}

/** Saca la tarea (con sus subtareas) de su nota: el documento que queda y la casilla. */
export function takeTask(row: NoteRow, task: Task): { doc: JSONContent; item: JSONContent } | null {
  const doc = parseBody(row.bodyJson);
  if (!doc) return null;
  const next = clone(doc);
  const item = cut(next, task.n);
  return item ? { doc: next, item } : null;
}

/** Una casilla nueva a partir de lo que se escribe («Llamar #casa»). */
export function newTaskItem(source: string, meta: { dueAt?: string | null; priority?: number } = {}): JSONContent {
  return { type: 'taskItem', attrs: { checked: false }, content: [paragraphOf(source, { tags: [], ...meta })] };
}

/**
 * El documento con la casilla añadida: al final de la nota (en su última lista
 * de tareas si la nota acaba en una) o, con `under`, como última subtarea de esa.
 */
export function addTaskItem(row: NoteRow | null, item: JSONContent, under?: Task): JSONContent {
  const doc = clone(parseBody(row?.bodyJson ?? null) ?? emptyDoc());
  doc.content ??= [];
  if (under) {
    const at = locate(doc, under.n);
    if (at) {
      at.item.content ??= [{ type: 'paragraph' }];
      const last = at.item.content[at.item.content.length - 1];
      if (last.type === 'taskList') last.content = [...(last.content ?? []), item];
      else at.item.content.push({ type: 'taskList', content: [item] });
      return doc;
    }
  }
  const last = doc.content[doc.content.length - 1];
  if (last?.type === 'taskList') last.content = [...(last.content ?? []), item];
  else {
    // Un párrafo vacío al final (el que deja el editor) se sustituye por la lista.
    if (last?.type === 'paragraph' && !last.content?.length && doc.content.length > 1) doc.content.pop();
    doc.content.push({ type: 'taskList', content: [item] });
  }
  return doc;
}

/** Lo que se guarda de una nota con este documento. */
export function contentOf(doc: JSONContent) {
  const bodyText = docText(doc);
  return { bodyJson: JSON.stringify(doc), bodyText, title: titleFrom(bodyText) };
}

/** Cuántas tareas tiene la nota y cuántas están hechas. */
export function taskCount(row: NoteRow) {
  const all = tasksOf(row);
  return { total: all.length, done: all.filter((t) => t.status === 'done').length, open: all.filter((t) => t.status !== 'done') };
}
