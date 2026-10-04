import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// La llave del MCP: quien la tenga puede leer y cambiar todas las notas, así
// que en la base solo se guarda su hash y se enseña una vez, al crearla.
// También puede venir de la variable CANVIAN_MCP_TOKEN (por ejemplo, en el
// docker-compose); entonces no se puede cambiar desde Configuración.

const KEY = 'mcp_token_hash';
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const envToken = () => process.env.CANVIAN_MCP_TOKEN?.trim() || null;

export function mcpStatus(db: Db) {
  const stored = db.select().from(settings).where(eq(settings.key, KEY)).get();
  return { enabled: !!envToken() || !!stored, fromEnv: !!envToken() };
}

export function createMcpToken(db: Db): string {
  const token = randomBytes(24).toString('base64url');
  const value = sha256(token).toString('hex');
  db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  return token;
}

export function revokeMcpToken(db: Db) {
  db.delete(settings).where(eq(settings.key, KEY)).run();
}

export function isMcpToken(db: Db, token: string | null | undefined): boolean {
  if (!token) return false;
  const given = sha256(token);
  const env = envToken();
  if (env && timingSafeEqual(given, sha256(env))) return true;
  const stored = db.select().from(settings).where(eq(settings.key, KEY)).get();
  return !!stored && timingSafeEqual(given, Buffer.from(stored.value, 'hex'));
}
