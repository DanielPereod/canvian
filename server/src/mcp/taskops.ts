import type { Db } from '../db/index.js';
import { addTaskItem, allTasks, type Task } from '../doc/tasks.js';
import type { JSONContent } from '../doc/json.js';
import { INBOX, McpError, contentOf, createNote, linkWikis, saveNote, type Note } from './notes.js';

// Añadir una casilla a una nota: lo comparten el MCP (add_task) y la extensión
// del navegador.

/** La nota «Tareas» de arriba del todo, donde va lo que se apunta sin decir dónde. */
export const inboxOf = (all: Note[]) =>
  all.find((n) => !n.zoneId && n.kind === 'text' && !n.archivedAt && n.title?.trim().toLocaleLowerCase('es') === INBOX.toLocaleLowerCase('es'));

/**
 * Pone `item` al final de `host` (o, con `under`, como su última subtarea).
 * Sin `host` va a «Tareas», que se crea si aún no existe, como hace la web.
 * Devuelve la nota guardada y la tarea nueva.
 */
export function insertTask(db: Db, profileId: string, all: Note[], item: JSONContent, where: { host?: Note; under?: Task } = {}): { row: Note; added: Task } {
  const host = where.host ?? inboxOf(all);
  const under = where.under;
  let row: Note;
  if (host) {
    const doc = addTaskItem(host, item, under);
    linkWikis(db, profileId, host.id, doc);
    row = saveNote(db, host.id, contentOf(doc));
  } else {
    const title = { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: INBOX }] };
    const doc = { type: 'doc', content: [title, { type: 'taskList', content: [item] }] };
    row = createNote(db, profileId, { doc, parentId: null });
    linkWikis(db, profileId, row.id, doc);
    row = saveNote(db, row.id, contentOf(doc));
  }
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
  return { row, added };
}

// «nota:n» → la tarea (comprobando que la nota sigue ahí y la tiene).
export function findTask(all: Note[], id: string): Task {
  const at = id.lastIndexOf(':');
  const noteId = id.slice(0, at);
  const n = Number(id.slice(at + 1));
  const row = all.find((x) => x.id === noteId);
  const task = row && Number.isInteger(n) ? allTasks([row])[n] : undefined;
  if (!task) throw new McpError(`No encuentro la tarea ${id}. Vuelve a listarlas con list_tasks: los ids cambian si se edita la nota.`);
  return task;
}
