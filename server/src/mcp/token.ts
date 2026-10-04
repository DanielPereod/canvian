import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// La llave del MCP: quien la tenga puede leer y cambiar todas las notas. Se
// guarda tal cual para poder enseñarla en Configuración (que ya pide sesión)
// y copiar desde allí la configuración de cada cliente. También puede venir de
// la variable CANVIAN_MCP_TOKEN; entonces no se puede cambiar desde la web.
// Las llaves de antes se guardaban solo como hash: siguen valiendo, pero no se
// pueden enseñar.

const KEY = 'mcp_token';
const OLD_HASH = 'mcp_token_hash';
const PUBLIC_URL = 'mcp_public_url';
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const envToken = () => process.env.CANVIAN_MCP_TOKEN?.trim() || null;

const get = (db: Db, key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const put = (db: Db, key: string, value: string) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();

export function mcpStatus(db: Db) {
  const env = envToken();
  const token = env ?? get(db, KEY);
  return {
    enabled: !!token || !!get(db, OLD_HASH),
    fromEnv: !!env,
    token,
    publicUrl: get(db, PUBLIC_URL),
  };
}

export function setMcpPublicUrl(db: Db, url: string | null) {
  if (url) put(db, PUBLIC_URL, url);
  else db.delete(settings).where(eq(settings.key, PUBLIC_URL)).run();
}

export function createMcpToken(db: Db): string {
  const token = randomBytes(24).toString('base64url');
  db.delete(settings).where(eq(settings.key, OLD_HASH)).run();
  put(db, KEY, token);
  return token;
}

export function revokeMcpToken(db: Db) {
  db.delete(settings).where(inArray(settings.key, [KEY, OLD_HASH])).run();
}

export function isMcpToken(db: Db, token: string | null | undefined): boolean {
  if (!token) return false;
  const given = sha256(token);
  const same = (other: string | null) => !!other && timingSafeEqual(given, sha256(other));
  if (same(envToken()) || same(get(db, KEY))) return true;
  const old = get(db, OLD_HASH);
  return !!old && timingSafeEqual(given, Buffer.from(old, 'hex'));
}
