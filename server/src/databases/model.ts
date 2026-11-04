import { and, asc, eq, inArray, max } from 'drizzle-orm';
import { ulid } from 'ulidx';
import type { Db } from '../db/index.js';
import { dbColumns, dbLinks, dbRows, dbTables } from '../db/schema.js';
import { convertValue } from '../routes/properties.js';

// Las bases de datos de cada perfil: tablas con columnas tipadas y filas, que
// no son notas. Lo comparten la API de la web, las consultas ```db``` y el MCP.

export const COLUMN_TYPES = ['text', 'number', 'select', 'tags', 'date', 'checkbox', 'url', 'image', 'note', 'relation'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export type ColumnOptions = {
  // Opciones y etiquetas: las que hay para elegir.
  choices?: string[];
  // Relaciones: la tabla a la que apunta, la columna pareja de esa tabla y si
  // los enlaces se guardan a nombre de esta (owner) o de la pareja.
  target?: string;
  pair?: string;
  owner?: boolean;
  // La primera columna de cada tabla: el nombre de la fila (no se borra).
  primary?: boolean;
};

export type Column = { id: string; tableId: string; name: string; type: ColumnType; options: ColumnOptions; position: number };
export type Table = { id: string; profileId: string; name: string; icon: string | null; folder: string | null; position: number; columns: Column[] };
export type Value = string | number | boolean | null | string[];
export type Row = { id: string; tableId: string; position: number; values: Record<string, Value>; createdAt: string; updatedAt: string };

// La conexión de better-sqlite3 que hay debajo de drizzle.
export const rawOf = (db: Db) => (db as unknown as { $client: import('better-sqlite3').Database }).$client;

export class DbError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Cómo se escribe un nombre en una consulta: sin tildes ni mayúsculas, con _
// en vez de espacios («Año de publicación» → año_de_publicacion → ano_de_publicacion).
export const keyOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

const parseOptions = (raw: string): ColumnOptions => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export const toColumn = (c: typeof dbColumns.$inferSelect): Column => ({ ...c, type: c.type as ColumnType, options: parseOptions(c.options) });

export function tablesOf(db: Db, profileId: string): Table[] {
  const tables = db.select().from(dbTables).where(eq(dbTables.profileId, profileId)).orderBy(asc(dbTables.position), asc(dbTables.createdAt)).all();
  if (!tables.length) return [];
  const cols = db
    .select()
    .from(dbColumns)
    .where(inArray(dbColumns.tableId, tables.map((t) => t.id)))
    .orderBy(asc(dbColumns.position))
    .all()
    .map(toColumn);
  return tables.map((t) => ({ id: t.id, profileId: t.profileId, name: t.name, icon: t.icon, folder: t.folder, position: t.position, columns: cols.filter((c) => c.tableId === t.id) }));
}

export function tableById(db: Db, id: string): Table | null {
  const t = db.select().from(dbTables).where(eq(dbTables.id, id)).get();
  if (!t) return null;
  return tablesOf(db, t.profileId).find((x) => x.id === id) ?? null;
}

export function findTable(tables: Table[], ref: string): Table | null {
  const k = keyOf(ref);
  return tables.find((t) => t.id === ref) ?? tables.find((t) => keyOf(t.name) === k) ?? null;
}

export function findColumn(table: Table, ref: string): Column | null {
  const k = keyOf(ref);
  return table.columns.find((c) => c.id === ref) ?? table.columns.find((c) => keyOf(c.name) === k) ?? null;
}

export const primaryOf = (t: Table) => t.columns.find((c) => c.options.primary) ?? t.columns[0];

// ── Valores ───────────────────────────────────────────────────────────

const uniq = (xs: string[]) => [...new Set(xs)];

// Un valor que llega (de la web, del MCP o de una mini app), pasado al tipo de
// la columna. undefined: la celda queda vacía. Las relaciones van aparte.
export function coerce(col: Column, v: unknown): Value | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  switch (col.type) {
    case 'relation':
      return Array.isArray(v) ? uniq(v.map(String)) : [String(v)];
    case 'checkbox':
      return v === true || v === 1 || (typeof v === 'string' && /^(true|1|s[ií]|x|yes)$/i.test(v.trim())) ? true : undefined;
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date': {
      const s = String(v).trim();
      return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/.test(s) ? s : undefined;
    }
    case 'tags': {
      const list = Array.isArray(v) ? v.map((x) => String(x).trim()) : String(v).split(',').map((x) => x.trim());
      const out = uniq(list.filter(Boolean)).slice(0, 200);
      return out.length ? out : undefined;
    }
    default: {
      const s = (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 100_000);
      return s.trim() ? s : undefined;
    }
  }
}

// Al cambiar el tipo de una columna, los valores se pasan al nuevo si se puede.
export function retypeValue(v: unknown, to: ColumnType): Value | undefined {
  const base = to === 'note' || to === 'image' ? 'text' : to;
  if (base === 'relation') return undefined;
  return convertValue(v, base as Parameters<typeof convertValue>[1]) as Value | undefined;
}

// ── Relaciones ────────────────────────────────────────────────────────

// Los enlaces de una columna de relación, vistos desde sus filas: fila → filas enlazadas.
export function linksOf(db: Db, col: Column, rowIds?: string[]): Map<string, string[]> {
  const owner = col.options.owner !== false;
  const colId = owner ? col.id : col.options.pair;
  const out = new Map<string, string[]>();
  if (!colId) return out;
  const side = owner ? dbLinks.fromId : dbLinks.toId;
  const rows = db
    .select()
    .from(dbLinks)
    .where(rowIds ? and(eq(dbLinks.columnId, colId), inArray(side, rowIds)) : eq(dbLinks.columnId, colId))
    .orderBy(asc(dbLinks.position))
    .all();
  for (const l of rows) {
    const [me, other] = owner ? [l.fromId, l.toId] : [l.toId, l.fromId];
    const list = out.get(me);
    if (list) list.push(other);
    else out.set(me, [other]);
  }
  return out;
}

export function setLinks(db: Db, col: Column, rowId: string, targets: string[]) {
  const owner = col.options.owner !== false;
  const colId = owner ? col.id : col.options.pair;
  if (!colId) return;
  const target = col.options.target;
  const valid = target && targets.length ? new Set(db.select({ id: dbRows.id }).from(dbRows).where(and(eq(dbRows.tableId, target), inArray(dbRows.id, targets))).all().map((r) => r.id)) : new Set<string>();
  const ids = uniq(targets).filter((id) => valid.has(id));
  db.delete(dbLinks)
    .where(and(eq(dbLinks.columnId, colId), eq(owner ? dbLinks.fromId : dbLinks.toId, rowId)))
    .run();
  if (!ids.length) return;
  db.insert(dbLinks)
    .values(ids.map((id, position) => (owner ? { columnId: colId, fromId: rowId, toId: id, position } : { columnId: colId, fromId: id, toId: rowId, position })))
    .onConflictDoNothing()
    .run();
}

// ── Filas ─────────────────────────────────────────────────────────────

const parseData = (raw: string): Record<string, Value> => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export function rowsOf(db: Db, table: Table, ids?: string[]): Row[] {
  const raw = db
    .select()
    .from(dbRows)
    .where(ids ? and(eq(dbRows.tableId, table.id), inArray(dbRows.id, ids)) : eq(dbRows.tableId, table.id))
    .orderBy(asc(dbRows.position), asc(dbRows.id))
    .all();
  const rels = table.columns.filter((c) => c.type === 'relation').map((c) => [c, linksOf(db, c, ids)] as const);
  return raw.map((r) => {
    const values = parseData(r.data);
    for (const [c, links] of rels) {
      const list = links.get(r.id);
      if (list?.length) values[c.id] = list;
      else delete values[c.id];
    }
    return { id: r.id, tableId: r.tableId, position: r.position, values, createdAt: r.createdAt, updatedAt: r.updatedAt };
  });
}

// Los nombres de unas filas (su columna principal), para enseñar las relaciones.
export function titlesOf(db: Db, tables: Table[], ids: string[]): Record<string, string> {
  if (!ids.length) return {};
  const out: Record<string, string> = {};
  const byTable = new Map(tables.map((t) => [t.id, t]));
  for (let i = 0; i < ids.length; i += 500) {
    const rows = db.select().from(dbRows).where(inArray(dbRows.id, ids.slice(i, i + 500))).all();
    for (const r of rows) {
      const t = byTable.get(r.tableId);
      const v = t ? parseData(r.data)[primaryOf(t).id] : null;
      out[r.id] = v === null || v === undefined ? '' : String(v);
    }
  }
  return out;
}

const nowIso = () => new Date().toISOString();

// Valores por id o por nombre de columna. Las relaciones aceptan ids de fila o
// sus nombres (la columna principal de la otra tabla).
export function normalizeValues(db: Db, tables: Table[], table: Table, input: Record<string, unknown>, strict: boolean): Record<string, Value | undefined> {
  const out: Record<string, Value | undefined> = {};
  for (const [k, v] of Object.entries(input)) {
    const col = findColumn(table, k);
    if (!col) {
      if (strict) throw new DbError(`«${table.name}» no tiene la columna «${k}». Columnas: ${table.columns.map((c) => c.name).join(', ')}.`);
      continue;
    }
    let value = coerce(col, v);
    if (col.type === 'relation' && Array.isArray(value)) {
      const target = tables.find((t) => t.id === col.options.target);
      if (!target) continue;
      const rows = rowsOf(db, target);
      const prim = primaryOf(target);
      value = value.flatMap((ref) => {
        const hit = rows.find((r) => r.id === ref) ?? rows.find((r) => keyOf(String(r.values[prim.id] ?? '')) === keyOf(ref));
        if (!hit && strict) throw new DbError(`En «${target.name}» no hay ninguna fila «${ref}».`);
        return hit ? [hit.id] : [];
      });
    }
    if (strict && value === undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && !v.length))
      throw new DbError(`«${String(v)}» no vale para la columna «${col.name}» (${col.type}).`);
    out[col.id] = value;
  }
  return out;
}

// Guarda los cambios de una fila (crea la fila si no existe). Las opciones
// nuevas de las columnas de opciones y etiquetas se añaden solas.
export function saveRow(db: Db, table: Table, rowId: string, values: Record<string, Value | undefined>, create: { position?: number } | null): Row {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    let current = t.select().from(dbRows).where(eq(dbRows.id, rowId)).get();
    if (current && current.tableId !== table.id) throw new DbError('Esa fila es de otra tabla', 409);
    if (!current) {
      if (!create) throw new DbError('Fila no encontrada', 404);
      const last = t.select({ p: max(dbRows.position) }).from(dbRows).where(eq(dbRows.tableId, table.id)).get();
      current = t
        .insert(dbRows)
        .values({ id: rowId, tableId: table.id, data: '{}', position: create.position ?? (last?.p ?? 0) + 1 })
        .returning()
        .get();
    }
    const data = parseData(current.data);
    for (const [id, v] of Object.entries(values)) {
      const col = table.columns.find((c) => c.id === id);
      if (!col) continue;
      if (col.type === 'relation') {
        setLinks(t, col, rowId, Array.isArray(v) ? v : []);
        continue;
      }
      if (v === undefined) delete data[id];
      else data[id] = v;
      if ((col.type === 'select' || col.type === 'tags') && v !== undefined) {
        const known = col.options.choices ?? [];
        const add = (Array.isArray(v) ? v : [String(v)]).filter((x) => !known.includes(x));
        if (add.length) {
          col.options = { ...col.options, choices: [...known, ...add] };
          t.update(dbColumns).set({ options: JSON.stringify(col.options) }).where(eq(dbColumns.id, col.id)).run();
        }
      }
    }
    t.update(dbRows).set({ data: JSON.stringify(data), updatedAt: nowIso() }).where(eq(dbRows.id, rowId)).run();
    return rowsOf(t, table, [rowId])[0];
  });
}

export function deleteRow(db: Db, rowId: string) {
  return db.delete(dbRows).where(eq(dbRows.id, rowId)).run().changes > 0;
}

// ── Tablas y columnas ─────────────────────────────────────────────────

export function createTable(db: Db, profileId: string, name: string, id = ulid(), folder: string | null = null): Table {
  const tables = tablesOf(db, profileId);
  if (!keyOf(name)) throw new DbError('El nombre necesita alguna letra o número');
  if (tables.some((t) => keyOf(t.name) === keyOf(name))) throw new DbError('Ya hay una tabla con ese nombre', 409);
  db.transaction((tx) => {
    tx.insert(dbTables).values({ id, profileId, name, folder, position: tables.length ? Math.max(...tables.map((t) => t.position)) + 1 : 0 }).run();
    tx.insert(dbColumns).values({ id: ulid(), tableId: id, name: 'Nombre', type: 'text', options: JSON.stringify({ primary: true }), position: 0 }).run();
  });
  return tableById(db, id)!;
}

export function deleteTable(db: Db, table: Table) {
  db.transaction((tx) => {
    // Las columnas de otras tablas que apuntaban a esta se van con ella.
    const pairs = table.columns.filter((c) => c.type === 'relation' && c.options.pair).map((c) => c.options.pair!);
    if (pairs.length) tx.delete(dbColumns).where(inArray(dbColumns.id, pairs)).run();
    tx.delete(dbTables).where(eq(dbTables.id, table.id)).run();
  });
}

const nameTaken = (table: Table, name: string, except?: string) => table.columns.some((c) => c.id !== except && keyOf(c.name) === keyOf(name));

// Un nombre libre en una tabla: «Libros», «Libros 2»…
const freeName = (table: Table, name: string) => {
  let n = name;
  for (let i = 2; nameTaken(table, n); i++) n = `${name} ${i}`;
  return n;
};

export function addColumn(db: Db, tables: Table[], table: Table, input: { id?: string; name: string; type: ColumnType; choices?: string[]; target?: string }): Column {
  if (!keyOf(input.name)) throw new DbError('El nombre necesita alguna letra o número');
  if (nameTaken(table, input.name)) throw new DbError('Ya hay una columna con ese nombre', 409);
  const id = input.id ?? ulid();
  const position = table.columns.length ? Math.max(...table.columns.map((c) => c.position)) + 1 : 0;
  const options: ColumnOptions = {};
  if (input.choices?.length) options.choices = uniq(input.choices);
  if (input.type !== 'relation') {
    db.insert(dbColumns).values({ id, tableId: table.id, name: input.name, type: input.type, options: JSON.stringify(options), position }).run();
    return toColumn(db.select().from(dbColumns).where(eq(dbColumns.id, id)).get()!);
  }
  const target = input.target ? tables.find((t) => t.id === input.target) : null;
  if (!target) throw new DbError('Elige la tabla con la que se relaciona');
  const pairId = ulid();
  // La columna pareja, en la otra tabla, con el nombre de esta tabla.
  const targetNow = target.id === table.id ? { ...table, columns: [...table.columns, { id, tableId: table.id, name: input.name, type: 'relation' as const, options: {}, position }] } : target;
  const pairName = freeName(targetNow, target.id === table.id ? `${input.name} (inversa)` : table.name);
  const pairPos = targetNow.columns.length ? Math.max(...targetNow.columns.map((c) => c.position)) + 1 : 0;
  db.transaction((tx) => {
    tx.insert(dbColumns).values({ id, tableId: table.id, name: input.name, type: 'relation', options: JSON.stringify({ target: target.id, pair: pairId, owner: true }), position }).run();
    tx.insert(dbColumns).values({ id: pairId, tableId: target.id, name: pairName, type: 'relation', options: JSON.stringify({ target: table.id, pair: id, owner: false }), position: pairPos }).run();
  });
  return toColumn(db.select().from(dbColumns).where(eq(dbColumns.id, id)).get()!);
}

export function deleteColumn(db: Db, col: Column) {
  if (col.options.primary) throw new DbError('La columna principal no se puede borrar', 409);
  db.transaction((tx) => {
    if (col.type === 'relation' && col.options.pair) tx.delete(dbColumns).where(eq(dbColumns.id, col.options.pair)).run();
    tx.delete(dbColumns).where(eq(dbColumns.id, col.id)).run();
    if (col.type !== 'relation') stripValue(tx as unknown as Db, col);
  });
}

function stripValue(db: Db, col: Column) {
  const rows = db.select().from(dbRows).where(eq(dbRows.tableId, col.tableId)).all();
  for (const r of rows) {
    const data = parseData(r.data);
    if (!(col.id in data)) continue;
    delete data[col.id];
    db.update(dbRows).set({ data: JSON.stringify(data) }).where(eq(dbRows.id, r.id)).run();
  }
}

export function updateColumn(db: Db, table: Table, col: Column, patch: { name?: string; type?: ColumnType; choices?: string[]; position?: number }): Column {
  if (patch.name !== undefined) {
    if (!keyOf(patch.name)) throw new DbError('El nombre necesita alguna letra o número');
    if (nameTaken(table, patch.name, col.id)) throw new DbError('Ya hay una columna con ese nombre', 409);
  }
  const retype = patch.type && patch.type !== col.type;
  if (retype && (col.type === 'relation' || patch.type === 'relation')) throw new DbError('Una relación no se puede convertir en otro tipo (ni al revés): crea una columna nueva');
  if (retype && col.options.primary && patch.type !== 'text') throw new DbError('La columna principal es siempre de texto', 409);
  const options = { ...col.options };
  if (patch.choices) options.choices = uniq(patch.choices);
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    if (retype) {
      const known = new Set(options.choices ?? []);
      for (const r of t.select().from(dbRows).where(eq(dbRows.tableId, table.id)).all()) {
        const data = parseData(r.data);
        if (!(col.id in data)) continue;
        const v = retypeValue(data[col.id], patch.type!);
        if (v === undefined) delete data[col.id];
        else data[col.id] = v;
        if (patch.type === 'select' && typeof v === 'string') known.add(v);
        if (patch.type === 'tags' && Array.isArray(v)) v.forEach((x) => known.add(x));
        t.update(dbRows).set({ data: JSON.stringify(data) }).where(eq(dbRows.id, r.id)).run();
      }
      if (patch.type === 'select' || patch.type === 'tags') options.choices = [...known];
    }
    t.update(dbColumns)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(retype ? { type: patch.type } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
        options: JSON.stringify(options),
      })
      .where(eq(dbColumns.id, col.id))
      .run();
  });
  return toColumn(db.select().from(dbColumns).where(eq(dbColumns.id, col.id)).get()!);
}

// ── CSV ───────────────────────────────────────────────────────────────

const csvCell = (v: Value | undefined) => {
  if (v === undefined || v === null) return '';
  const s = Array.isArray(v) ? v.join(', ') : v === true ? 'true' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(db: Db, tables: Table[], table: Table): string {
  const rows = rowsOf(db, table);
  const relIds = rows.flatMap((r) => table.columns.filter((c) => c.type === 'relation').flatMap((c) => (r.values[c.id] as string[] | undefined) ?? []));
  const titles = titlesOf(db, tables, [...new Set(relIds)]);
  const lines = [table.columns.map((c) => csvCell(c.name)).join(',')];
  for (const r of rows) {
    lines.push(table.columns.map((c) => {
      const v = r.values[c.id];
      return csvCell(c.type === 'relation' && Array.isArray(v) ? v.map((id) => titles[id] ?? id) : v);
    }).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  // El separador: coma o punto y coma (el Excel en español usa «;»).
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// Qué tipo parece tener una columna del CSV, por sus valores.
function guessType(values: string[]): ColumnType {
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return 'text';
  if (vs.every((v) => /^-?\d+([.,]\d+)?$/.test(v))) return 'number';
  if (vs.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v))) return 'date';
  if (vs.every((v) => /^(true|false|s[ií]|no|x|0|1)$/i.test(v))) return 'checkbox';
  if (vs.every((v) => /^https?:\/\//i.test(v))) return 'url';
  return 'text';
}

// Importa un CSV a una tabla: la primera fila son los nombres de columna; las
// que no existen se crean con el tipo que parecen tener. Las relaciones se
// enlazan por nombre.
export function importCsv(db: Db, profileId: string, table: Table, text: string): { rows: number; columns: number } {
  const [head, ...body] = parseCsv(text);
  if (!head?.length) throw new DbError('El CSV está vacío');
  if (body.length > 20_000) throw new DbError('Como mucho 20.000 filas por importación');
  let created = 0;
  let t = table;
  const cols = head.map((name, i) => {
    const clean = name.trim() || `Columna ${i + 1}`;
    const hit = findColumn(t, clean);
    if (hit) return hit;
    const col = addColumn(db, tablesOf(db, profileId), t, { name: clean, type: guessType(body.map((r) => r[i] ?? '')) });
    created++;
    t = tableById(db, t.id)!;
    return col;
  });
  const tables = tablesOf(db, profileId);
  t = tables.find((x) => x.id === t.id)!;
  db.transaction((tx) => {
    for (const r of body) {
      const input: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = r[i] ?? '';
        if (!v.trim()) return;
        input[c.id] = c.type === 'relation' ? v.split(',').map((x) => x.trim()).filter(Boolean) : c.type === 'checkbox' ? /^(true|s[ií]|x|1)$/i.test(v.trim()) : v;
      });
      saveRow(tx as unknown as Db, t, ulid(), normalizeValues(tx as unknown as Db, tables, t, input, false), {});
    }
  });
  return { rows: body.length, columns: created };
}
