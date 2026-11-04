import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

let app: ReturnType<typeof createApp>;
let cookie = '';
let profileId = '';

const call = async (method: string, path: string, body?: unknown, raw?: string) => {
  const res = await app.request(path, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // CSV
  }
  return { status: res.status, data };
};
const query = (q: string) => call('POST', `/api/profiles/${profileId}/db/query`, { query: q });

let libros: any;
let autores: any;
const col = (t: any, name: string) => t.columns.find((c: any) => c.name === name);

beforeEach(async () => {
  app = createApp(openDb(':memory:'));
  const res = await app.request('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'una-clave-larga' }) });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  profileId = (await call('GET', '/api/profiles')).data[0].id;

  autores = (await call('POST', `/api/profiles/${profileId}/db/tables`, { name: 'Autores' })).data;
  libros = (await call('POST', `/api/profiles/${profileId}/db/tables`, { name: 'Libros' })).data;
  await call('POST', `/api/db/tables/${autores.id}/columns`, { name: 'País', type: 'select' });
  await call('POST', `/api/db/tables/${libros.id}/columns`, { name: 'Nota', type: 'number' });
  await call('POST', `/api/db/tables/${libros.id}/columns`, { name: 'Leído', type: 'checkbox' });
  await call('POST', `/api/db/tables/${libros.id}/columns`, { name: 'Etiquetas', type: 'tags' });
  await call('POST', `/api/db/tables/${libros.id}/columns`, { name: 'Autor', type: 'relation', target: autores.id });
  const tables = (await call('GET', `/api/profiles/${profileId}/db`)).data;
  autores = tables.find((t: any) => t.name === 'Autores');
  libros = tables.find((t: any) => t.name === 'Libros');

  const a = async (nombre: string, pais: string) => (await call('POST', `/api/db/tables/${autores.id}/rows`, { values: { Nombre: nombre, País: pais } })).data.id;
  const tolkien = await a('Tolkien', 'Reino Unido');
  const leguin = await a('Ursula K. Le Guin', 'EE. UU.');
  await a('Borges', 'Argentina');
  const l = (values: Record<string, unknown>) => call('POST', `/api/db/tables/${libros.id}/rows`, { values });
  await l({ Nombre: 'El hobbit', Nota: 4, Leído: true, Etiquetas: ['fantasía'], Autor: [tolkien] });
  await l({ Nombre: 'El Silmarillion', Nota: 3, Leído: false, Etiquetas: ['fantasía', 'mitos'], Autor: [tolkien] });
  await l({ Nombre: 'Terramar', Nota: 5, Leído: true, Etiquetas: 'fantasía, clásicos', Autor: ['Ursula K. Le Guin'] });
  await l({ Nombre: 'Los desposeídos', Nota: 5, Autor: [leguin] });
  const now = (await call('GET', `/api/profiles/${profileId}/db`)).data;
  libros = now.find((t: any) => t.name === 'Libros');
  autores = now.find((t: any) => t.name === 'Autores');
});

describe('bases de datos', () => {
  it('crea tablas con su columna principal y la relación con su pareja', async () => {
    expect(libros.columns.map((c: any) => c.name)).toEqual(['Nombre', 'Nota', 'Leído', 'Etiquetas', 'Autor']);
    expect(autores.columns.map((c: any) => c.name)).toEqual(['Nombre', 'País', 'Libros']);
    expect(libros.rows).toBe(4);
    const { data } = await call('GET', `/api/db/tables/${autores.id}/rows`);
    const tolkien = data.rows.find((r: any) => r.values[col(autores, 'Nombre').id] === 'Tolkien');
    expect(tolkien.values[col(autores, 'Libros').id].map((id: string) => data.titles[id]).sort()).toEqual(['El Silmarillion', 'El hobbit']);
    expect(col(autores, 'País').options.choices).toEqual(['Reino Unido', 'EE. UU.', 'Argentina']);
  });

  it('no repite nombres de tabla ni de columna', async () => {
    expect((await call('POST', `/api/profiles/${profileId}/db/tables`, { name: 'libros' })).status).toBe(409);
    expect((await call('POST', `/api/db/tables/${libros.id}/columns`, { name: 'nota', type: 'text' })).status).toBe(409);
  });

  it('consulta con filtros, orden y relaciones', async () => {
    const { status, data } = await query('SELECT nombre, autor.nombre, nota FROM libros WHERE leido = true AND nota >= 4 ORDER BY nota DESC');
    expect(status).toBe(200);
    expect(data.columns.map((c: any) => c.name)).toEqual(['Nombre', 'autor.nombre', 'Nota']);
    expect(data.rows).toEqual([
      ['Terramar', ['Ursula K. Le Guin'], 5],
      ['El hobbit', ['Tolkien'], 4],
    ]);
    expect(data.ids).toHaveLength(2);
  });

  it('filtra por la tabla relacionada y por etiquetas', async () => {
    const byAuthor = await query("SELECT nombre FROM libros WHERE autor.pais = 'Reino Unido' ORDER BY nombre");
    expect(byAuthor.data.rows).toEqual([['El hobbit'], ['El Silmarillion']]);
    const bare = await query("SELECT nombre FROM libros WHERE autor = 'Tolkien' ORDER BY 1");
    expect(bare.data.rows.length).toBe(2);
    const tags = await query("SELECT nombre FROM libros WHERE etiquetas CONTAINS 'MITOS'");
    expect(tags.data.rows).toEqual([['El Silmarillion']]);
    const eq = await query("SELECT count(*) FROM libros WHERE etiquetas = 'fantasía'");
    expect(eq.data.rows).toEqual([[3]]);
    const none = await query('SELECT nombre FROM autores WHERE libros IS NULL');
    expect(none.data.rows).toEqual([['Borges']]);
  });

  it('agrupa y cuenta enlaces', async () => {
    const g = await query('SELECT autor.nombre AS quien, count(*) AS n, avg(nota) FROM libros GROUP BY autor ORDER BY n DESC, quien');
    expect(g.status).toBe(200);
    expect(g.data.ids).toBeNull();
    const counts = await query('SELECT nombre, libros.count() AS total FROM autores ORDER BY total DESC, nombre');
    expect(counts.data.rows).toEqual([
      ['Tolkien', 2],
      ['Ursula K. Le Guin', 2],
      ['Borges', 0],
    ]);
    const total = await query('SELECT sum(nota), max(nota) FROM libros');
    expect(total.data.rows).toEqual([[17, 5]]);
  });

  it('solo deja leer y explica los errores', async () => {
    for (const bad of ['DELETE FROM libros', 'SELECT * FROM notes', 'SELECT nada FROM libros', "SELECT nombre FROM libros; DROP TABLE notes", 'SELECT nombre FROM libros JOIN autores', 'SELECT load_extension(1) FROM libros']) {
      const r = await query(bad);
      expect(r.status, bad).toBe(400);
      expect(typeof r.data.error).toBe('string');
    }
    expect((await query('SELECT nombre FROM libros WHERE nombre = \'x\' OR 1=1')).data.rows.length).toBe(4);
    // Lo de otro perfil no se ve.
    const other = (await call('POST', '/api/profiles', { name: 'Otro' })).data.id;
    expect((await call('POST', `/api/profiles/${other}/db/query`, { query: 'SELECT * FROM libros' })).status).toBe(400);
  });

  it('cambia valores, relaciones y tipos, y borra en cascada', async () => {
    const rows = (await call('GET', `/api/db/tables/${libros.id}/rows`)).data.rows;
    const hobbit = rows[0];
    const r = await call('PATCH', `/api/db/rows/${hobbit.id}`, { values: { [col(libros, 'Nota').id]: '4,5', [col(libros, 'Autor').id]: [] } });
    expect(r.data.values[col(libros, 'Nota').id]).toBe(4.5);
    expect(r.data.values[col(libros, 'Autor').id]).toBeUndefined();
    const retype = await call('PATCH', `/api/db/columns/${col(libros, 'Nota').id}`, { type: 'text' });
    expect(retype.data.type).toBe('text');
    expect((await query('SELECT nota FROM libros LIMIT 1')).data.rows).toEqual([['4.5']]);
    expect((await call('PATCH', `/api/db/columns/${col(libros, 'Autor').id}`, { type: 'text' })).status).toBe(400);
    expect((await call('DELETE', `/api/db/columns/${col(libros, 'Nombre').id}`)).status).toBe(409);
    // Borrar la relación quita también su pareja.
    expect((await call('DELETE', `/api/db/columns/${col(libros, 'Autor').id}`)).status).toBe(204);
    const after = (await call('GET', `/api/profiles/${profileId}/db`)).data;
    expect(after.find((t: any) => t.name === 'Autores').columns.map((c: any) => c.name)).toEqual(['Nombre', 'País']);
    expect((await call('DELETE', `/api/db/tables/${libros.id}`)).status).toBe(204);
    expect((await call('GET', `/api/profiles/${profileId}/db`)).data.map((t: any) => t.name)).toEqual(['Autores']);
  });

  it('exporta e importa CSV', async () => {
    const out = await call('GET', `/api/db/tables/${libros.id}/csv`);
    expect(out.status).toBe(200);
    expect(out.data).toContain('Nombre,Nota,Leído,Etiquetas,Autor');
    expect(out.data).toContain('"fantasía, clásicos"');
    const csv = 'Nombre;Nota;Autor;Año\nDune;5;Borges;1965\n"Ficciones; cuentos";4;Borges;1944\n';
    const res = await call('POST', `/api/db/tables/${libros.id}/csv`, undefined, csv);
    expect(res.data).toEqual({ rows: 2, columns: 1 });
    const q = await query('SELECT nombre, ano FROM libros WHERE autor = \'Borges\' ORDER BY ano');
    expect(q.data.rows).toEqual([
      ['Ficciones; cuentos', 1944],
      ['Dune', 1965],
    ]);
  });
});
