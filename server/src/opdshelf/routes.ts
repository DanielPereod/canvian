import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { listProfiles } from '../mcp/notes.js';
import { OpdshelfError, clearOpdshelf, configBody, opdshelfStatus, setOpdshelfConfig, type OpdshelfWorker } from './sync.js';

// Configuración › opdshelf (con sesión): la conexión, sincronizar ahora y quitarla.
export function opdshelfRoutes(db: Db, worker: OpdshelfWorker) {
  const r = new Hono();

  r.get('/opdshelf', (c) => c.json(opdshelfStatus(db)));

  r.put('/opdshelf', async (c) => {
    const body = configBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Dirección de opdshelf no válida' }, 400);
    if (body.data.profileId && !listProfiles(db).some((p) => p.id === body.data.profileId)) return c.json({ error: 'Perfil no encontrado' }, 404);
    setOpdshelfConfig(db, body.data);
    worker.start();
    return c.json(opdshelfStatus(db));
  });

  r.delete('/opdshelf', (c) => {
    worker.stop();
    clearOpdshelf(db);
    return c.body(null, 204);
  });

  // «all»: vuelve a traer todos los libros, no solo los que cambiaron.
  r.post('/opdshelf/sync', async (c) => {
    const all = (await c.req.json().catch(() => ({})))?.all === true;
    try {
      const result = await worker.sync(all);
      return c.json({ ...result, status: opdshelfStatus(db) });
    } catch (e) {
      if (e instanceof OpdshelfError) return c.json({ error: e.message, status: opdshelfStatus(db) }, 502);
      throw e;
    }
  });

  return r;
}
