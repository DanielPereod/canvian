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
