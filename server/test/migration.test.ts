import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';

const sectionTree = readFileSync(fileURLToPath(new URL('../drizzle/0003_section_tree.sql', import.meta.url)), 'utf8');

describe('0003_section_tree', () => {
  it('stores in zone_id the section that held each note on the old canvas', () => {
    const path = join(tmpdir(), `canvian-migration-${process.pid}.db`);
    openDb(path);
    const sqlite = new Database(path);
    sqlite.exec(`INSERT INTO profiles (id, name, position, background) VALUES ('p', 'Personal', 0, 'dots')`);
    const add = sqlite.prepare(`INSERT INTO notes (id, profile_id, kind, x, y, w, h, zone_id) VALUES (?, 'p', ?, ?, ?, ?, ?, ?)`);
    add.run('casa', 'zone', 0, 0, 1000, 800, null);
    add.run('bano', 'zone', 100, 100, 400, 300, null);
    add.run('en-bano', 'text', 150, 150, null, null, null);
    add.run('en-casa', 'text', 700, 500, null, null, null);
    add.run('fuera', 'text', 2000, 2000, null, null, null);
    add.run('ya-puesta', 'text', 150, 150, null, null, 'casa');
    for (const statement of sectionTree.split('--> statement-breakpoint')) sqlite.exec(statement);
    const zoneOf = Object.fromEntries(sqlite.prepare('SELECT id, zone_id FROM notes').all().map((r) => [(r as { id: string }).id, (r as { zone_id: string | null }).zone_id]));
    expect(zoneOf).toEqual({ casa: null, bano: 'casa', 'en-bano': 'bano', 'en-casa': 'casa', fuera: null, 'ya-puesta': 'casa' });
    expect(sqlite.prepare('SELECT background FROM profiles').get()).toEqual({ background: 'plain' });
    sqlite.close();
    for (const end of ['', '-wal', '-shm']) rmSync(path + end, { force: true });
  });
});
