import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';

const notesTree = readFileSync(fileURLToPath(new URL('../drizzle/0004_notes_tree.sql', import.meta.url)), 'utf8');
const sectionTree = readFileSync(fileURLToPath(new URL('../drizzle/0003_section_tree.sql', import.meta.url)), 'utf8');

describe('0003_section_tree', () => {
  it('stores in zone_id the section that held each note on the old canvas', () => {
    const path = join(tmpdir(), `canvian-migration-${process.pid}.db`);
    openDb(path);
    const sqlite = new Database(path);
    sqlite.exec(`INSERT INTO profiles (id, name, position) VALUES ('p', 'Personal', 0)`);
    const add = sqlite.prepare(`INSERT INTO notes (id, profile_id, kind, x, y, w, h, zone_id) VALUES (?, 'p', ?, ?, ?, ?, ?, ?)`);
    add.run('casa', 'zone', 0, 0, 1000, 800, null);
    add.run('bano', 'zone', 100, 100, 400, 300, null);
    add.run('en-bano', 'text', 150, 150, null, null, null);
    add.run('en-casa', 'text', 700, 500, null, null, null);
    add.run('fuera', 'text', 2000, 2000, null, null, null);
    add.run('ya-puesta', 'text', 150, 150, null, null, 'casa');
    // Sin la parte de los fondos del perfil: esa columna ya no existe (0006).
    for (const statement of sectionTree.split('--> statement-breakpoint')) if (!statement.includes('`background`')) sqlite.exec(statement);
    const zoneOf = Object.fromEntries(sqlite.prepare('SELECT id, zone_id FROM notes').all().map((r) => [(r as { id: string }).id, (r as { zone_id: string | null }).zone_id]));
    expect(zoneOf).toEqual({ casa: null, bano: 'casa', 'en-bano': 'bano', 'en-casa': 'casa', fuera: null, 'ya-puesta': 'casa' });
    sqlite.close();
    for (const end of ['', '-wal', '-shm']) rmSync(path + end, { force: true });
  });
});

describe('0004_notes_tree', () => {
  it('turns each zone into a note whose text is its name, keeping its children', () => {
    const path = join(tmpdir(), `canvian-migration4-${process.pid}.db`);
    openDb(path);
    const sqlite = new Database(path);
    sqlite.exec(`INSERT INTO profiles (id, name, position) VALUES ('p', 'Personal', 0)`);
    const add = sqlite.prepare(`INSERT INTO notes (id, profile_id, kind, title, zone_id) VALUES (?, 'p', ?, ?, ?)`);
    add.run('viaje', 'zone', 'Viaje a «Japón»', null);
    add.run('ruta', 'text', 'Ruta', 'viaje');
    add.run('sin-nombre', 'zone', null, null);
    sqlite.exec(notesTree);
    const rows = sqlite.prepare('SELECT id, kind, zone_id, body_json, body_text FROM notes ORDER BY id').all() as Record<string, string | null>[];
    expect(rows.map((r) => r.kind)).toEqual(['text', 'text', 'text']);
    const viaje = rows.find((r) => r.id === 'viaje')!;
    expect(viaje.body_text).toBe('Viaje a «Japón»');
    expect(JSON.parse(viaje.body_json!).content[0].content[0]).toEqual({ type: 'text', marks: [{ type: 'bold' }], text: 'Viaje a «Japón»' });
    expect(rows.find((r) => r.id === 'ruta')!.zone_id).toBe('viaje');
    expect(JSON.parse(rows.find((r) => r.id === 'sin-nombre')!.body_json!).content[0].content).toEqual([]);
    expect(sqlite.prepare(`SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'japon'`).get()).toEqual({ n: 1 });
    sqlite.close();
    for (const end of ['', '-wal', '-shm']) rmSync(path + end, { force: true });
  });
});

describe('task notes → checkboxes', () => {
  it('turns task notes into checkboxes in their parent note, and quick tasks into «Tareas»', () => {
    const path = join(tmpdir(), `canvian-migration-tasks-${process.pid}.db`);
    openDb(path);
    const sqlite = new Database(path);
    sqlite.exec(`INSERT INTO profiles (id, name, position) VALUES ('p', 'Personal', 0)`);
    sqlite.exec(`INSERT INTO property_defs (id, profile_id, name, type) VALUES ('tags', 'p', 'Etiquetas', 'tags')`);
    const doc = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const add = sqlite.prepare(
      `INSERT INTO notes (id, profile_id, kind, title, body_json, body_text, zone_id, status, priority, due_at, done_at, props, created_at) VALUES (?, 'p', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    add.run('casa', 'text', 'Casa', doc('Casa'), 'Casa', null, null, null, null, null, '{}', '2026-01-01');
    add.run('bombillas', 'task', 'Cambiar bombillas', doc('Cambiar bombillas'), 'Cambiar bombillas', 'casa', 'doing', 3, '2026-10-02', null, '{"tags":["luz"]}', '2026-01-02');
    add.run('persiana', 'task', 'Arreglar la persiana', doc('Arreglar la persiana'), 'Arreglar la persiana\nLlamar al técnico', 'casa', 'done', null, null, '2026-09-01T10:00:00Z', '{}', '2026-01-03');
    add.run('pan', 'quick', 'Comprar pan', null, null, null, 'todo', null, null, null, '{}', '2026-01-04');
    add.run('borrada', 'task', 'Ya no', doc('Ya no'), 'Ya no', 'casa', 'todo', null, null, null, '{}', '2026-01-05');
    sqlite.exec(`UPDATE notes SET deleted_at = '2026-02-01' WHERE id = 'borrada'`);
    sqlite.close();

    // Al volver a abrir se migra (y otra vez no cambia nada).
    openDb(path);
    openDb(path);
    const db = new Database(path);
    const rows = db.prepare('SELECT id, kind, title, body_json, body_text, deleted_at FROM notes ORDER BY created_at').all() as Record<string, string | null>[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // Una tarea que era solo una línea desaparece; la que tenía más texto se queda como nota.
    expect(byId.bombillas.deleted_at).not.toBeNull();
    expect(byId.persiana).toMatchObject({ kind: 'text', deleted_at: null });
    expect(byId.pan.deleted_at).not.toBeNull();
    expect(byId.borrada.kind).toBe('task');

    const list = JSON.parse(byId.casa.body_json!).content.at(-1);
    expect(list.type).toBe('taskList');
    expect(list.content).toEqual([
      { type: 'taskItem', attrs: { checked: false, status: 'doing' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cambiar bombillas #luz 📅 2026-10-02 ⏫' }] }] },
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { id: 'persiana', target: 'Arreglar la persiana', alias: null } }, { type: 'text', text: ' ✅ 2026-09-01' }] }],
      },
    ]);
    expect(byId.casa.body_text).toBe('Casa\nCambiar bombillas #luz 📅 2026-10-02 ⏫\nArreglar la persiana ✅ 2026-09-01');

    const inbox = rows.find((r) => r.title === 'Tareas' && !r.deleted_at)!;
    expect(inbox.kind).toBe('text');
    expect(JSON.parse(inbox.body_json!).content[1].content[0].content[0].content[0].text).toBe('Comprar pan');
    expect(db.prepare(`SELECT count(*) AS n FROM notes WHERE kind IN ('task', 'quick') AND deleted_at IS NULL`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM notes WHERE title = 'Tareas'`).get()).toEqual({ n: 1 });
    db.close();
    for (const end of ['', '-wal', '-shm']) rmSync(path + end, { force: true });
  });
});
