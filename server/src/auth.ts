import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { settings, sessions } from './db/schema.js';

export const SESSION_COOKIE = 'canvian_session';
export const SESSION_DAYS = 30;
const PASSWORD_KEY = 'password_hash';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function isSetupDone(db: Db): boolean {
  return db.select().from(settings).where(eq(settings.key, PASSWORD_KEY)).get() !== undefined;
}

export async function setPassword(db: Db, password: string): Promise<void> {
  const value = await hash(password);
  db.insert(settings)
    .values({ key: PASSWORD_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export async function checkPassword(db: Db, password: string): Promise<boolean> {
  const row = db.select().from(settings).where(eq(settings.key, PASSWORD_KEY)).get();
  if (!row) return false;
  return verify(row.value, password);
}

// Devuelve el token en claro para la cookie; en la base solo guardamos su hash.
export function createSession(db: Db): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
  db.insert(sessions).values({ id: sha256(token), expiresAt: expiresAt.toISOString() }).run();
  return { token, expiresAt };
}

export function isValidSession(db: Db, token: string | undefined): boolean {
  if (!token) return false;
  const row = db.select().from(sessions).where(eq(sessions.id, sha256(token))).get();
  return row !== undefined && row.expiresAt > new Date().toISOString();
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.delete(sessions).where(eq(sessions.id, sha256(token))).run();
}
