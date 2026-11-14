import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db/index.js';

const port = Number(process.env.PORT ?? 3210);
const dbPath = resolve(process.env.CANVIAN_DB ?? './data/canvian.db');
// La web compilada se sirve desde el mismo proceso en producción.
const webDir =
  process.env.CANVIAN_WEB_DIR ??
  fileURLToPath(new URL('../../web/dist', import.meta.url));

// Los archivos pegados en las notas viven junto a la base, en el mismo volumen.
const mediaDir = resolve(process.env.CANVIAN_MEDIA ?? join(dirname(dbPath), 'media'));

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const app = createApp(db, { mediaDir });

// serveStatic espera una ruta relativa al directorio de trabajo.
const root = relative(process.cwd(), webDir) || '.';
// La página se pide siempre de nuevo (si no, el navegador o la app de Android
// pueden seguir horas con la versión vieja tras actualizar); lo de /assets
// lleva el hash en el nombre y no cambia nunca.
const onFound = (path: string, c: { header: (name: string, value: string) => void }) =>
  c.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
app.use('/*', serveStatic({ root, onFound }));
app.get('*', serveStatic({ path: join(root, 'index.html'), onFound }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Canvian escuchando en http://0.0.0.0:${port} (base de datos: ${dbPath})`);
});
