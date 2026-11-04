import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { dbTables, profiles } from '../db/schema.js';
import {
  COLUMN_TYPES,
  DbError,
  addColumn,
  createTable,
  deleteColumn,
  deleteRow,
  deleteTable,
  importCsv,
  normalizeValues,
  rowsOf,
  saveRow,
  tableById,
  tablesOf,
  titlesOf,
  toCsv,
  updateColumn,
  keyOf,
  rawOf,
  type Table,
} from '../databases/model.js';
import { runQuery } from '../databases/query.js';

// La API de las bases de datos (ver databases/model.ts). Las tablas cuelgan
// del perfil; columnas y filas, de su tabla.

const id = z.string().min(10).max(40);
const name = z.string().trim().min(1).max(80);
const folder = z.string().trim().max(80).nullable().transform((v) => v || null);
const tableCreate = z.object({ id: id.optional(), name, folder: folder.optional() });
const tablePatch = z.object({ name, icon: z.string().max(40).nullable(), position: z.number().int(), folder }).partial();
const choices = z.array(z.string().trim().min(1).max(80)).max(2000);
const columnCreate = z.object({ id: id.optional(), name, type: z.enum(COLUMN_TYPES), choices: choices.optional(), target: id.optional() });
const columnPatch = z.object({ name, type: z.enum(COLUMN_TYPES), choices, position: z.number().int() }).partial();
const value = z.union([z.string().max(100_000), z.number(), z.boolean(), z.null(), z.array(z.string().max(1000)).max(2000)]);
const rowCreate = z.object({ id: id.optional(), values: z.record(z.string(), value).default({}), position: z.number().optional() });
const rowPatch = z.object({ values: z.record(z.string(), value).optional(), position: z.number().optional() });
const queryBody = z.object({ query: z.string().min(1).max(5000) });

const json = async (c: Context) => c.req.json().catch(() => null);

// «Hoy» en la zona del servidor (TZ), como en el MCP.
export const localDay = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const fail = (c: Context, e: unknown) => {
  if (e instanceof DbError) return c.json({ error: e.message }, e.status as 400);
  throw e;
};

export function databaseRoutes(db: Db) {
  const r = new Hono();

  const profileOk = (pid: string) => !!db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, pid)).get();
  const withTable = (c: Context, fn: (t: Table) => Response | Promise<Response>) => {
    const t = tableById(db, c.req.param('id')!);
    if (!t) return c.json({ error: 'Tabla no encontrada' }, 404);
    try {
      return fn(t);
    } catch (e) {
      return fail(c, e);
    }
  };
  // La tabla de una columna o de una fila.
  const tableOfColumn = (colId: string) => {
    const row = rawOf(db).prepare('SELECT table_id FROM db_columns WHERE id = ?').get(colId) as { table_id: string } | undefined;
    return row ? tableById(db, row.table_id) : null;
  };
  const tableOfRow = (rowId: string) => {
    const row = rawOf(db).prepare('SELECT table_id FROM db_rows WHERE id = ?').get(rowId) as { table_id: string } | undefined;
    return row ? tableById(db, row.table_id) : null;
  };

  // Todas las tablas del perfil, con sus columnas y cuántas filas tienen.
  r.get('/profiles/:id/db', (c) => {
    const pid = c.req.param('id');
    const counts = new Map(
      (rawOf(db).prepare('SELECT r.table_id AS id, count(*) AS n FROM db_rows r JOIN db_tables t ON t.id = r.table_id WHERE t.profile_id = ? GROUP BY r.table_id').all(pid) as { id: string; n: number }[]).map((x) => [x.id, x.n]),
    );
    return c.json(tablesOf(db, pid).map((t) => ({ ...t, rows: counts.get(t.id) ?? 0 })));
  });

  r.post('/profiles/:id/db/tables', async (c) => {
    const pid = c.req.param('id');
    if (!profileOk(pid)) return c.json({ error: 'Perfil no encontrado' }, 404);
    const body = tableCreate.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Tabla no válida' }, 400);
    try {
      return c.json(createTable(db, pid, body.data.name, body.data.id, body.data.folder ?? null), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/profiles/:id/db/query', async (c) => {
    const body = queryBody.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Consulta no válida' }, 400);
    try {
      return c.json(runQuery(db, tablesOf(db, c.req.param('id')), body.data.query, localDay()));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.patch('/db/tables/:id', async (c) => {
    const body = tablePatch.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
    return withTable(c, (t) => {
      if (body.data.name !== undefined) {
        if (!keyOf(body.data.name)) throw new DbError('El nombre necesita alguna letra o número');
        if (tablesOf(db, t.profileId).some((x) => x.id !== t.id && keyOf(x.name) === keyOf(body.data.name!))) throw new DbError('Ya hay una tabla con ese nombre', 409);
      }
      db.update(dbTables).set({ ...body.data, updatedAt: new Date().toISOString() }).where(eq(dbTables.id, t.id)).run();
      return c.json(tableById(db, t.id));
    });
  });

  r.delete('/db/tables/:id', (c) =>
    withTable(c, (t) => {
      deleteTable(db, t);
      return c.body(null, 204);
    }),
  );

  // Las filas, con los nombres de las filas enlazadas por sus relaciones.
  r.get('/db/tables/:id/rows', (c) =>
    withTable(c, (t) => {
      const rows = rowsOf(db, t);
      const rel = t.columns.filter((x) => x.type === 'relation');
      const ids = new Set<string>();
      for (const row of rows) for (const col of rel) for (const x of (row.values[col.id] as string[] | undefined) ?? []) ids.add(x);
      return c.json({ rows, titles: titlesOf(db, tablesOf(db, t.profileId), [...ids]) });
    }),
  );

  r.post('/db/tables/:id/columns', async (c) => {
    const body = columnCreate.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Columna no válida' }, 400);
    return withTable(c, (t) => c.json(addColumn(db, tablesOf(db, t.profileId), t, body.data), 201));
  });

  r.patch('/db/columns/:id', async (c) => {
    const body = columnPatch.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
    const t = tableOfColumn(c.req.param('id'));
    const col = t?.columns.find((x) => x.id === c.req.param('id'));
    if (!t || !col) return c.json({ error: 'Columna no encontrada' }, 404);
    try {
      return c.json(updateColumn(db, t, col, body.data));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.delete('/db/columns/:id', (c) => {
    const t = tableOfColumn(c.req.param('id'));
    const col = t?.columns.find((x) => x.id === c.req.param('id'));
    if (!t || !col) return c.json({ error: 'Columna no encontrada' }, 404);
    try {
      deleteColumn(db, col);
      return c.body(null, 204);
    } catch (e) {
      return fail(c, e);
    }
  });

  r.post('/db/tables/:id/rows', async (c) => {
    const body = rowCreate.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Fila no válida' }, 400);
    return withTable(c, (t) => {
      const rowId = body.data.id ?? ulid();
      const values = normalizeValues(db, tablesOf(db, t.profileId), t, body.data.values, false);
      return c.json(saveRow(db, t, rowId, values, { position: body.data.position }), 201);
    });
  });

  r.patch('/db/rows/:id', async (c) => {
    const body = rowPatch.safeParse(await json(c));
    if (!body.success) return c.json({ error: 'Cambios no válidos' }, 400);
    const rowId = c.req.param('id');
    const t = tableOfRow(rowId);
    if (!t) return c.json({ error: 'Fila no encontrada' }, 404);
    try {
      if (body.data.position !== undefined) rawOf(db).prepare('UPDATE db_rows SET position = ? WHERE id = ?').run(body.data.position, rowId);
      const values = normalizeValues(db, tablesOf(db, t.profileId), t, body.data.values ?? {}, false);
      return c.json(saveRow(db, t, rowId, values, null));
    } catch (e) {
      return fail(c, e);
    }
  });

  r.delete('/db/rows/:id', (c) => (deleteRow(db, c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'Fila no encontrada' }, 404)));

  // CSV: exportar la tabla entera e importar filas (y columnas nuevas).
  r.get('/db/tables/:id/csv', (c) =>
    withTable(c, (t) => {
      const name = encodeURIComponent(`${t.name}.csv`);
      return c.body('﻿' + toCsv(db, tablesOf(db, t.profileId), t), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
      });
    }),
  );

  r.post('/db/tables/:id/csv', async (c) => {
    const text = await c.req.text().catch(() => '');
    if (!text.trim()) return c.json({ error: 'El CSV está vacío' }, 400);
    if (text.length > 20_000_000) return c.json({ error: 'El CSV es demasiado grande' }, 413);
    return withTable(c, (t) => c.json(importCsv(db, t.profileId, t, text)));
  });

  return r;
}
