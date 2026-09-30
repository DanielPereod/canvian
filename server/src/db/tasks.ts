import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';

// Las tareas ya no son notas: son las casillas «- [ ]» de dentro de las notas
// (una casilla sangrada bajo otra es su subtarea). Esto pasa las tareas de
// antes a casillas, una sola vez: después ya no queda ninguna nota de tipo
// `task` ni `quick`, así que volver a llamarlo no hace nada.
//
// - Cada tarea va como casilla al final de su nota madre, con su fecha
//   («📅 2026-10-02»), su prioridad («⏫ 🔼 🔽»), sus etiquetas («#casa») y, si
//   estaba hecha, cuándo («✅ …»). En curso es «[/]» y bloqueada «[!]».
// - Si la tarea tenía algo más que su título (texto, notas dentro o enlaces),
//   se queda como nota normal y la casilla la enlaza: «- [ ] [[Título]]».
//   Si no, era solo una línea: la nota va a la papelera.
// - Las tareas rápidas, y las que no estaban dentro de ninguna nota, van a una
//   nota «Tareas» arriba del todo (la que ya haya o una nueva).

type Row = {
  id: string;
  profile_id: string;
  kind: string;
  title: string | null;
  body_json: string | null;
  body_text: string | null;
  props: string;
  zone_id: string | null;
  status: string | null;
  priority: number | null;
  due_at: string | null;
  done_at: string | null;
};
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: unknown[] };

const INBOX = 'Tareas';
const PRIO_MARK = ['', '🔽', '🔼', '⏫'];
const day = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

export function migrateTaskNotes(sqlite: Database.Database) {
  const tasks = sqlite
    .prepare(`SELECT * FROM notes WHERE kind IN ('task', 'quick') AND deleted_at IS NULL ORDER BY created_at, id`)
    .all() as Row[];
  if (!tasks.length) return;

  const live = sqlite.prepare(`SELECT id, zone_id, kind, title, body_json, body_text FROM notes WHERE id = ? AND deleted_at IS NULL`);
  const hasKids = sqlite.prepare(`SELECT 1 FROM notes WHERE zone_id = ? AND deleted_at IS NULL LIMIT 1`);
  const hasEdges = sqlite.prepare(`SELECT 1 FROM edges WHERE from_id = ? OR to_id = ? LIMIT 1`);
  const tagDefs = sqlite.prepare(`SELECT id FROM property_defs WHERE profile_id = ? AND type = 'tags'`);
  const findInbox = sqlite.prepare(
    `SELECT id FROM notes WHERE profile_id = ? AND zone_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL AND kind = 'text' AND lower(trim(title)) = lower(?) LIMIT 1`,
  );
  const insertNote = sqlite.prepare(`INSERT INTO notes (id, profile_id, kind, title, body_json, body_text, x, y) VALUES (?, ?, 'text', ?, ?, ?, 0, 0)`);
  const setBody = sqlite.prepare(`UPDATE notes SET body_json = ?, body_text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
  const toText = sqlite.prepare(`UPDATE notes SET kind = 'text', status = NULL, done_at = NULL WHERE id = ?`);
  const trash = sqlite.prepare(`UPDATE notes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);

  // Madre de una tarea: la nota que la contenía, si sigue ahí y no es otra tarea
  // que vaya a desaparecer (entonces, la madre de esa).
  const keep = new Map<string, boolean>();
  const keeps = (t: Row) => {
    if (keep.has(t.id)) return keep.get(t.id)!;
    const body = (t.body_text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const extra = body.length > 1 || (body.length === 1 && body[0] !== (t.title ?? '').trim()) || (t.body_json ?? '').match(/"type":"(image|video|audio|table)"/) !== null;
    const k = t.kind === 'task' && (extra || !!hasKids.get(t.id) || !!hasEdges.get(t.id, t.id));
    keep.set(t.id, k);
    return k;
  };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const hostOf = (t: Row): string | null => {
    if (t.kind === 'quick') return null;
    let z = t.zone_id;
    for (let hops = 0; z && hops < 50; hops++) {
      const up = byId.get(z);
      if (up && !keeps(up)) {
        z = up.zone_id;
        continue;
      }
      const row = live.get(z) as { kind: string } | undefined;
      return row && row.kind !== 'canvas' ? z : null;
    }
    return null;
  };

  sqlite.transaction(() => {
    const items = new Map<string, { host: string | null; profile: string; list: Json[]; lines: string[] }>();
    for (const t of tasks) {
      const title = (t.title ?? '').trim();
      if (!title && !keeps(t)) {
        trash.run(t.id);
        continue;
      }
      let props: Record<string, unknown> = {};
      try {
        props = JSON.parse(t.props || '{}');
      } catch {
        // Sin propiedades legibles, sin etiquetas.
      }
      const tags = (tagDefs.all(t.profile_id) as { id: string }[])
        .flatMap((d) => (Array.isArray(props[d.id]) ? (props[d.id] as string[]) : []))
        .map((x) => x.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-'))
        .filter(Boolean);
      const done = t.status === 'done';
      const tail = [
        ...tags.map((x) => `#${x}`),
        day(t.due_at) ? `📅 ${day(t.due_at)}` : '',
        PRIO_MARK[t.priority ?? 0] ?? '',
        done ? `✅ ${day(t.done_at) ?? new Date().toISOString().slice(0, 10)}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const kept = keeps(t);
      const content: Json[] = kept
        ? [{ type: 'wikilink', attrs: { id: t.id, target: title || 'Nota sin título', alias: null } }, ...(tail ? [{ type: 'text', text: ` ${tail}` }] : [])]
        : [{ type: 'text', text: tail ? `${title} ${tail}` : title }];
      const status = !done && (t.status === 'doing' || t.status === 'blocked') ? { status: t.status } : {};
      const item: Json = { type: 'taskItem', attrs: { checked: done, ...status }, content: [{ type: 'paragraph', content }] };

      const host = hostOf(t);
      const key = host ?? `inbox:${t.profile_id}`;
      const bucket = items.get(key) ?? { host, profile: t.profile_id, list: [], lines: [] };
      bucket.list.push(item);
      bucket.lines.push(`${title || 'Nota sin título'}${tail ? ` ${tail}` : ''}`);
      items.set(key, bucket);

      if (kept) toText.run(t.id);
      else trash.run(t.id);
    }

    for (const { host, profile, list, lines } of items.values()) {
      let id = host ?? (findInbox.get(profile, INBOX) as { id: string } | undefined)?.id ?? null;
      if (!id) {
        id = ulid();
        const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: INBOX }] }] };
        insertNote.run(id, profile, INBOX, JSON.stringify(doc), INBOX);
      }
      const row = live.get(id) as { body_json: string | null; body_text: string | null };
      let doc: Json = { type: 'doc', content: [] };
      try {
        const parsed = row.body_json ? (JSON.parse(row.body_json) as Json) : null;
        if (parsed?.type === 'doc') doc = parsed;
      } catch {
        // Un cuerpo ilegible se queda como está y la lista va en uno nuevo.
      }
      const blocks = [...(doc.content ?? [])];
      // El párrafo vacío que deja el editor al final no hace falta; una lista de tareas al final, se alarga.
      const last = blocks[blocks.length - 1];
      if (blocks.length > 1 && last?.type === 'paragraph' && !last.content?.length) blocks.pop();
      const end = blocks[blocks.length - 1];
      if (end?.type === 'taskList') blocks[blocks.length - 1] = { ...end, content: [...(end.content ?? []), ...list] };
      else blocks.push({ type: 'taskList', content: list });
      doc.content = blocks;
      setBody.run(JSON.stringify(doc), [row.body_text ?? '', ...lines].filter(Boolean).join('\n'), id);
    }
  })();
}
