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

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const app = createApp(db);

// serveStatic espera una ruta relativa al directorio de trabajo.
const root = relative(process.cwd(), webDir) || '.';
app.use('/*', serveStatic({ root }));
app.get('*', serveStatic({ path: join(root, 'index.html') }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Canvian escuchando en http://0.0.0.0:${port} (base de datos: ${dbPath})`);
});
