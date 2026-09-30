import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { migrateTaskNotes } from './tasks.js';

export type Db = BetterSQLite3Database<typeof schema>;

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  migrateTaskNotes(sqlite);
  return db;
}

export { schema };
