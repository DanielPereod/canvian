import type { Db } from '../db/index.js';
import { DbError, keyOf, rawOf, primaryOf, type Column, type Table } from './model.js';

// Las consultas de los bloques ```db```, de las mini apps y del MCP: un trozo
// de SQL de solo lectura. No se pasa nunca a SQLite tal cual: se analiza aquí
// y se traduce a una consulta sobre db_rows con los valores como parámetros,
// así que solo puede leer las tablas del perfil.
//
//   SELECT titulo, autor.nombre, nota FROM libros
//   WHERE leido = true AND nota >= 4 ORDER BY nota DESC LIMIT 10
//
// Las relaciones se siguen con un punto (autor.nombre); autor.count() cuenta
// los enlaces.

export class QueryError extends DbError {}

const MAX_LENGTH = 5000;
const MAX_DEPTH = 40;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

// ── Léxico ────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'id'; v: string; quoted: boolean; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number };

const OPS = ['<=', '>=', '!=', '<>', '||', '(', ')', ',', '.', '*', '+', '-', '/', '%', '=', '<', '>', ';'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const at = i;
    if (/\d/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), at });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new QueryError(ch === "'" ? 'Falta cerrar un texto con \'' : `Falta cerrar un nombre con ${ch}`);
        if (src[i] === ch && src[i + 1] === ch) {
          s += ch;
          i += 2;
        } else if (src[i] === ch) {
          i++;
          break;
        } else s += src[i++];
      }
      out.push(ch === "'" ? { t: 'str', v: s, at } : { t: 'id', v: s, quoted: true, at });
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0], quoted: false, at });
      i += id[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new QueryError(`No entiendo «${ch}» (posición ${i + 1})`);
    out.push({ t: 'op', v: op, at });
    i += op.length;
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

// ── Sintaxis ──────────────────────────────────────────────────────────

export type Expr =
  | { k: 'lit'; v: string | number | boolean | null }
  | { k: 'ref'; path: string[] }
  | { k: 'count'; path: string[] }
  | { k: 'star' }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'neg'; e: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'isnull'; e: Expr; not: boolean }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'like'; e: Expr; pat: Expr; not: boolean }
  | { k: 'contains'; e: Expr; v: Expr; not: boolean };

export type Query = {
  distinct: boolean;
  items: { e: Expr; alias: string | null; label: string }[] | '*';
  from: string;
  where: Expr | null;
  group: Expr[];
  order: { e: Expr; desc: boolean }[];
  limit: number | null;
  offset: number | null;
};

const KEYWORDS = new Set(['select', 'distinct', 'from', 'where', 'group', 'by', 'order', 'asc', 'desc', 'limit', 'offset', 'and', 'or', 'not', 'is', 'null', 'true', 'false', 'like', 'in', 'between', 'as', 'contains', 'having', 'join', 'union', 'insert', 'update', 'delete', 'drop']);

export function parse(src: string): Query {
  if (src.length > MAX_LENGTH) throw new QueryError('La consulta es demasiado larga');
  const toks = lex(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const kw = (w: string, tok = peek()) => tok.t === 'id' && !tok.quoted && tok.v.toLowerCase() === w;
  const isOp = (o: string, tok = peek()) => tok.t === 'op' && tok.v === o;
  const near = (tok = peek()) => (tok.t === 'end' ? 'al final' : `cerca de «${src.slice(tok.at, tok.at + 18).split('\n')[0]}»`);
  const fail = (msg: string): never => {
    throw new QueryError(`${msg} (${near()})`);
  };
  const eatKw = (w: string) => (kw(w) ? (p++, true) : false);
  const eatOp = (o: string) => (isOp(o) ? (p++, true) : false);
  const needKw = (w: string) => eatKw(w) || fail(`Falta ${w.toUpperCase()}`);
  const needOp = (o: string) => eatOp(o) || fail(`Falta «${o}»`);
  const name = (): string => {
    const tok = peek();
    if (tok.t !== 'id' || (!tok.quoted && KEYWORDS.has(tok.v.toLowerCase()))) return fail('Esperaba un nombre');
    p++;
    return (tok as { v: string }).v;
  };

  const primary = (): Expr => {
    const tok = peek();
    if (tok.t === 'num') {
      p++;
      return { k: 'lit', v: tok.v };
    }
    if (tok.t === 'str') {
      p++;
      return { k: 'lit', v: tok.v };
    }
    if (eatOp('(')) {
      const e = expr();
      needOp(')');
      return e;
    }
    if (eatKw('null')) return { k: 'lit', v: null };
    if (eatKw('true')) return { k: 'lit', v: true };
    if (eatKw('false')) return { k: 'lit', v: false };
    if (tok.t === 'id') {
      const first = name();
      // Una función: count(*), lower(x), today()…
      if (!(tok as { quoted: boolean }).quoted && isOp('(')) {
        p++;
        const args: Expr[] = [];
        if (isOp('*')) {
          p++;
          args.push({ k: 'star' });
        } else if (!isOp(')')) {
          do args.push(expr());
          while (eatOp(','));
        }
        needOp(')');
        return { k: 'call', name: first.toLowerCase(), args };
      }
      const path = [first];
      while (eatOp('.')) {
        const t2 = peek();
        const seg = name();
        if (t2.t === 'id' && !t2.quoted && t2.v.toLowerCase() === 'count' && isOp('(')) {
          p++;
          needOp(')');
          return { k: 'count', path };
        }
        path.push(seg);
      }
      if (path.length > 3) fail('Solo se puede seguir una relación (autor.nombre)');
      return { k: 'ref', path };
    }
    return fail('Esperaba un valor o una columna');
  };
  const unary = (): Expr => (eatOp('-') ? { k: 'neg', e: unary() } : primary());
  const mul = (): Expr => {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (peek() as { v: string }).v;
      p++;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const add = (): Expr => {
    let a = mul();
    while (isOp('+') || isOp('-') || isOp('||')) {
      const op = (peek() as { v: string }).v;
      p++;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const cmp = (): Expr => {
    const a = add();
    for (const op of ['=', '!=', '<>', '<=', '>=', '<', '>']) if (eatOp(op)) return { k: 'bin', op: op === '<>' ? '!=' : op, a, b: add() };
    if (eatKw('is')) {
      const not = eatKw('not');
      needKw('null');
      return { k: 'isnull', e: a, not };
    }
    const not = eatKw('not');
    if (eatKw('like')) return { k: 'like', e: a, pat: add(), not };
    if (eatKw('contains')) return { k: 'contains', e: a, v: add(), not };
    if (eatKw('between')) {
      const lo = add();
      needKw('and');
      return { k: 'between', e: a, lo, hi: add(), not };
    }
    if (eatKw('in')) {
      needOp('(');
      const list: Expr[] = [];
      do list.push(add());
      while (eatOp(','));
      needOp(')');
      return { k: 'in', e: a, list, not };
    }
    if (not) fail('Después de NOT esperaba LIKE, IN, BETWEEN o CONTAINS');
    return a;
  };
  const notE = (): Expr => (eatKw('not') ? { k: 'not', e: notE() } : cmp());
  const and = (): Expr => {
    let a = notE();
    while (eatKw('and')) a = { k: 'bin', op: 'and', a, b: notE() };
    return a;
  };
  const expr = (): Expr => {
    if (++depth > MAX_DEPTH) fail('La consulta anida demasiado');
    let a = and();
    while (eatKw('or')) a = { k: 'bin', op: 'or', a, b: and() };
    depth--;
    return a;
  };
  const int = (what: string) => {
    const tok = peek();
    if (tok.t !== 'num' || !Number.isInteger(tok.v)) return fail(`${what} necesita un número entero`);
    p++;
    return tok.v;
  };

  if (!kw('select')) fail(/^\s*(insert|update|delete|drop|create|alter|replace|attach|pragma)\b/i.test(src) ? 'Solo se pueden hacer consultas de lectura (SELECT)' : 'La consulta empieza por SELECT');
  p++;
  const distinct = eatKw('distinct');
  let items: Query['items'];
  if (eatOp('*')) items = '*';
  else {
    items = [];
    do {
      const start = peek().at;
      const e = expr();
      const end = peek().at;
      let alias: string | null = null;
      if (eatKw('as')) alias = name();
      else if (peek().t === 'id' && !KEYWORDS.has((peek() as { v: string }).v.toLowerCase())) alias = name();
      items.push({ e, alias, label: alias ?? src.slice(start, end).trim() });
    } while (eatOp(','));
  }
  needKw('from');
  const from = name();
  if (isOp(',') || kw('join')) fail('Solo se consulta una tabla; para otras, sigue sus relaciones con un punto (autor.nombre)');
  const where = eatKw('where') ? expr() : null;
  const group: Expr[] = [];
  if (eatKw('group')) {
    needKw('by');
    do group.push(expr());
    while (eatOp(','));
  }
  if (kw('having')) fail('HAVING aún no se puede usar');
  const order: Query['order'] = [];
  if (eatKw('order')) {
    needKw('by');
    do {
      const e = expr();
      const desc = eatKw('desc');
      if (!desc) eatKw('asc');
      order.push({ e, desc });
    } while (eatOp(','));
  }
  let limit: number | null = null;
  let offset: number | null = null;
  if (eatKw('limit')) {
    limit = int('LIMIT');
    if (eatKw('offset')) offset = int('OFFSET');
  }
  eatOp(';');
  if (peek().t !== 'end') fail('Sobra algo');
  return { distinct, items, from, where, group, order, limit, offset };
}

// ── Traducción ────────────────────────────────────────────────────────

export type OutType = 'text' | 'number' | 'date' | 'checkbox' | 'url' | 'image' | 'note' | 'select' | 'list' | 'any';
export type Result = {
  table: { id: string; name: string };
  columns: { name: string; type: OutType }[];
  rows: unknown[][];
  // El id de cada fila (si la consulta no agrupa), para poder abrirla.
  ids: string[] | null;
  more: boolean;
};

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'total', 'group_concat']);
const SCALAR: Record<string, [number, number]> = {
  lower: [1, 1],
  upper: [1, 1],
  length: [1, 1],
  abs: [1, 1],
  round: [1, 2],
  coalesce: [2, 8],
  ifnull: [2, 2],
  substr: [2, 3],
  trim: [1, 1],
  replace: [3, 3],
  today: [0, 0],
  now: [0, 0],
  year: [1, 1],
  month: [1, 1],
  day: [1, 1],
  date_add: [2, 2],
  days: [2, 2],
};

const VIRTUAL: Record<string, { sql: (a: string) => string; type: OutType }> = {
  id: { sql: (a) => `${a}.id`, type: 'text' },
  creada: { sql: (a) => `${a}.created_at`, type: 'date' },
  created: { sql: (a) => `${a}.created_at`, type: 'date' },
  editada: { sql: (a) => `${a}.updated_at`, type: 'date' },
  updated: { sql: (a) => `${a}.updated_at`, type: 'date' },
};

type Resolved =
  | { k: 'col'; col: Column; table: Table; virtual?: undefined }
  | { k: 'virtual'; name: string; table: Table }
  | { k: 'through'; rel: Column; target: Table; col: Column | null; virtual: string | null };

export function compile(q: Query, tables: Table[], today: string) {
  const k = keyOf(q.from);
  const table = tables.find((t) => keyOf(t.name) === k);
  if (!table) throw new QueryError(`No hay ninguna tabla «${q.from}». ${tables.length ? `Tablas: ${tables.map((t) => t.name).join(', ')}.` : 'Aún no hay tablas.'}`);
  // Parámetros con nombre: el SQL se compone en otro orden que los valores.
  const params: Record<string, unknown> = {};
  let paramN = 0;
  const P = (v: unknown) => {
    const k = `p${paramN++}`;
    params[k] = typeof v === 'boolean' ? Number(v) : v;
    return `@${k}`;
  };
  let aliasN = 0;

  const colIn = (t: Table, name: string) => {
    const kk = keyOf(name);
    return t.columns.find((c) => keyOf(c.name) === kk) ?? null;
  };
  const noCol = (t: Table, name: string): never => {
    throw new QueryError(`«${t.name}» no tiene la columna «${name}». Columnas: ${t.columns.map((c) => keyOf(c.name)).join(', ')}.`);
  };
  const resolve = (path: string[]): Resolved => {
    let segs = path;
    if (segs.length > 1 && keyOf(segs[0]) === keyOf(table.name) && !colIn(table, segs[0])) segs = segs.slice(1);
    const first = colIn(table, segs[0]);
    if (segs.length === 1) {
      if (first) return { k: 'col', col: first, table };
      if (VIRTUAL[keyOf(segs[0])]) return { k: 'virtual', name: keyOf(segs[0]), table };
      return noCol(table, segs[0]);
    }
    if (segs.length > 2) throw new QueryError(`Solo se puede seguir una relación: «${path.join('.')}»`);
    if (!first) return noCol(table, segs[0]);
    if (first.type !== 'relation') throw new QueryError(`«${first.name}» no es una relación: no se puede escribir «${path.join('.')}»`);
    const target = tables.find((t) => t.id === first.options.target);
    if (!target) throw new QueryError(`La relación «${first.name}» apunta a una tabla que ya no existe`);
    const col = colIn(target, segs[1]);
    if (col) {
      if (col.type === 'relation') throw new QueryError(`Solo se puede seguir una relación: «${path.join('.')}»`);
      return { k: 'through', rel: first, target, col, virtual: null };
    }
    if (VIRTUAL[keyOf(segs[1])]) return { k: 'through', rel: first, target, col: null, virtual: keyOf(segs[1]) };
    return noCol(target, segs[1]);
  };

  // El valor de una columna (no relación) en la fila con alias `a`.
  const valueSql = (col: Column, a: string) => {
    const v = `json_extract(${a}.data, ${P(`$."${col.id}"`)})`;
    return col.type === 'checkbox' ? `coalesce(${v}, 0)` : v;
  };
  // Los enlaces de una relación desde la fila `a`: FROM … JOIN db_rows t.
  const linkJoin = (rel: Column, a: string, t: string) => {
    const owner = rel.options.owner !== false;
    const colId = owner ? rel.id : rel.options.pair;
    const l = `l${aliasN++}`;
    const [me, other] = owner ? ['from_id', 'to_id'] : ['to_id', 'from_id'];
    return { sql: `db_links ${l} JOIN db_rows ${t} ON ${t}.id = ${l}.${other} WHERE ${l}.column_id = ${P(colId)} AND ${l}.${me} = ${a}.id`, order: `${l}.position` };
  };
  const listOf = (rel: Column, inner: (t: string) => string) => {
    const t = `t${aliasN++}`;
    const j = linkJoin(rel, 'r', t);
    return `(SELECT json_group_array(v) FROM (SELECT ${inner(t)} AS v FROM ${j.sql} ORDER BY ${j.order}))`;
  };

  // Dentro de una condición, «autor.nombre» se refiere a una fila enlazada
  // cualquiera: la condición entera va en un EXISTS por cada relación que nombra.
  type Ctx = { bound: Map<string, string>; inPredicate: boolean };
  const top: Ctx = { bound: new Map(), inPredicate: false };

  const typeOf = (e: Expr): OutType => {
    if (e.k === 'ref') {
      const r = resolve(e.path);
      if (r.k === 'col') return r.col.type === 'relation' || r.col.type === 'tags' ? 'list' : (r.col.type as OutType);
      if (r.k === 'virtual') return VIRTUAL[r.name].type;
      return 'list';
    }
    if (e.k === 'count') return 'number';
    if (e.k === 'call') {
      if (['count', 'sum', 'avg', 'total', 'length', 'abs', 'round', 'year', 'month', 'day', 'days'].includes(e.name)) return 'number';
      if (['today', 'date_add'].includes(e.name)) return 'date';
      if (['min', 'max', 'coalesce', 'ifnull'].includes(e.name) && e.args[0]) return typeOf(e.args[0]);
      return 'text';
    }
    if (e.k === 'lit') return typeof e.v === 'number' ? 'number' : typeof e.v === 'boolean' ? 'checkbox' : 'text';
    if (e.k === 'bin' && ['+', '-', '*', '/', '%'].includes(e.op)) return 'number';
    if (e.k === 'neg') return 'number';
    if (e.k === 'bin' || e.k === 'not' || e.k === 'isnull' || e.k === 'in' || e.k === 'between' || e.k === 'like' || e.k === 'contains') return 'checkbox';
    return 'any';
  };

  // Las relaciones que nombra una expresión con un punto (o la relación sola
  // en una comparación: «autor = 'Tolkien'» es «autor.nombre = 'Tolkien'»).
  const relsIn = (e: Expr, out: Map<string, Column>, ctx: Ctx) => {
    const visit = (x: Expr) => {
      if (x.k === 'ref') {
        const r = resolve(x.path);
        if (r.k === 'through' && !ctx.bound.has(r.rel.id)) out.set(r.rel.id, r.rel);
        if (r.k === 'col' && r.col.type === 'relation' && !ctx.bound.has(r.col.id)) out.set(r.col.id, r.col);
        return;
      }
      if (x.k === 'call' && AGGREGATES.has(x.name)) return;
      for (const v of Object.values(x)) {
        if (Array.isArray(v)) v.forEach((y) => y && typeof y === 'object' && 'k' in y && visit(y as Expr));
        else if (v && typeof v === 'object' && 'k' in v) visit(v as Expr);
      }
    };
    visit(e);
  };

  const isList = (e: Expr) => {
    if (e.k !== 'ref') return false;
    const r = resolve(e.path);
    return r.k === 'col' && r.col.type === 'tags';
  };

  const predicate = (e: Expr, ctx: Ctx, body: (ctx: Ctx) => string): string => {
    const rels = new Map<string, Column>();
    relsIn(e, rels, ctx);
    if (!rels.size) return body(ctx);
    // Cada relación nombrada, una fila enlazada cualquiera que cumpla.
    const inner: Ctx = { bound: new Map(ctx.bound), inPredicate: true };
    const joins: string[] = [];
    for (const rel of rels.values()) {
      const t = `t${aliasN++}`;
      joins.push(linkJoin(rel, 'r', t).sql);
      inner.bound.set(rel.id, t);
    }
    const cond = body(inner);
    // Se anidan: EXISTS (… AND EXISTS (… AND cond)).
    return joins.reduceRight((acc, j) => `EXISTS (SELECT 1 FROM ${j} AND ${acc})`, `(${cond})`);
  };

  const ref = (path: string[], ctx: Ctx): string => {
    const r = resolve(path);
    if (r.k === 'virtual') return VIRTUAL[r.name].sql('r');
    if (r.k === 'col') {
      if (r.col.type !== 'relation') return valueSql(r.col, 'r');
      const bound = ctx.bound.get(r.col.id);
      const target = tables.find((t) => t.id === r.col.options.target);
      if (!target) throw new QueryError(`La relación «${r.col.name}» apunta a una tabla que ya no existe`);
      if (bound) return valueSql(primaryOf(target), bound);
      return listOf(r.col, (t) => valueSql(primaryOf(target), t));
    }
    const bound = ctx.bound.get(r.rel.id);
    const inner = (t: string) => (r.col ? valueSql(r.col, t) : VIRTUAL[r.virtual!].sql(t));
    if (bound) return inner(bound);
    return listOf(r.rel, inner);
  };

  const lit = (v: string | number | boolean | null) => (v === null ? 'NULL' : P(v));

  const ex = (e: Expr, ctx: Ctx): string => {
    switch (e.k) {
      case 'lit':
        return lit(e.v);
      case 'ref':
        return ref(e.path, ctx);
      case 'star':
        throw new QueryError('«*» solo vale en SELECT * o count(*)');
      case 'count': {
        const r = resolve(e.path);
        const rel = r.k === 'col' && r.col.type === 'relation' ? r.col : null;
        if (!rel) throw new QueryError(`«${e.path.join('.')}.count()» solo vale para relaciones`);
        const owner = rel.options.owner !== false;
        const [me] = owner ? ['from_id'] : ['to_id'];
        return `(SELECT count(*) FROM db_links WHERE column_id = ${P(owner ? rel.id : rel.options.pair)} AND ${me} = r.id)`;
      }
      case 'call': {
        const name = e.name;
        if (AGGREGATES.has(name)) {
          if (name === 'count' && e.args.length === 1 && e.args[0].k === 'star') return 'count(*)';
          if (e.args.length !== 1 && !(name === 'group_concat' && e.args.length === 2)) throw new QueryError(`${name}() lleva un valor`);
          return `${name}(${e.args.map((a) => ex(a, ctx)).join(', ')})`;
        }
        const arity = SCALAR[name];
        if (!arity) throw new QueryError(`No conozco la función ${name}(). Funciones: count, sum, avg, min, max, ${Object.keys(SCALAR).join(', ')}`);
        if (e.args.length < arity[0] || e.args.length > arity[1]) throw new QueryError(`${name}() no lleva ${e.args.length} valores`);
        const a = e.args.map((x) => ex(x, ctx));
        switch (name) {
          case 'today':
            return P(today);
          case 'now':
            return P(new Date().toISOString());
          case 'year':
            return `cast(strftime('%Y', ${a[0]}) AS integer)`;
          case 'month':
            return `cast(strftime('%m', ${a[0]}) AS integer)`;
          case 'day':
            return `cast(strftime('%d', ${a[0]}) AS integer)`;
          case 'date_add':
            return `date(${a[0]}, printf('%+d days', ${a[1]}))`;
          case 'days':
            return `cast(julianday(${a[1]}) - julianday(${a[0]}) AS integer)`;
          default:
            return `${name}(${a.join(', ')})`;
        }
      }
      case 'neg':
        return `(-${ex(e.e, ctx)})`;
      case 'not':
        return `(NOT ${ex(e.e, ctx)})`;
      case 'bin': {
        if (e.op === 'and' || e.op === 'or') return `(${ex(e.a, ctx)} ${e.op.toUpperCase()} ${ex(e.b, ctx)})`;
        if (['=', '!=', '<', '<=', '>', '>='].includes(e.op)) {
          // «etiquetas = 'x'» es que la lleva.
          if (isList(e.a) && e.op === '=') return ex({ k: 'contains', e: e.a, v: e.b, not: false }, ctx);
          if (isList(e.a) && e.op === '!=') return ex({ k: 'contains', e: e.a, v: e.b, not: true }, ctx);
          return predicate(e, ctx, (c) => `(${ex(e.a, c)} ${e.op} ${ex(e.b, c)})`);
        }
        if (e.op === '||') return `(coalesce(${ex(e.a, ctx)}, '') || coalesce(${ex(e.b, ctx)}, ''))`;
        return `(${ex(e.a, ctx)} ${e.op} ${ex(e.b, ctx)})`;
      }
      case 'isnull': {
        // «autor IS NULL»: sin ningún enlace. «etiquetas IS NULL»: sin ninguna.
        if (e.e.k === 'ref') {
          const r = resolve(e.e.path);
          if (r.k === 'col' && r.col.type === 'relation' && !ctx.bound.has(r.col.id)) {
            const owner = r.col.options.owner !== false;
            return `(${e.not ? '' : 'NOT '}EXISTS (SELECT 1 FROM db_links WHERE column_id = ${P(owner ? r.col.id : r.col.options.pair)} AND ${owner ? 'from_id' : 'to_id'} = r.id))`;
          }
          if (r.k === 'col' && r.col.type === 'tags') return `(coalesce(json_array_length(${valueSql(r.col, 'r')}), 0) ${e.not ? '>' : '='} 0)`;
          if (r.k === 'col' && r.col.type === 'checkbox') return `(${valueSql(r.col, 'r')} ${e.not ? '!=' : '='} 0)`;
        }
        return predicate(e, ctx, (c) => `(${ex(e.e, c)} IS ${e.not ? 'NOT ' : ''}NULL)`);
      }
      case 'in':
        return predicate(e, ctx, (c) => `(${ex(e.e, c)} ${e.not ? 'NOT ' : ''}IN (${e.list.map((x) => ex(x, c)).join(', ')}))`);
      case 'between':
        return predicate(e, ctx, (c) => `(${ex(e.e, c)} ${e.not ? 'NOT ' : ''}BETWEEN ${ex(e.lo, c)} AND ${ex(e.hi, c)})`);
      case 'like':
        return predicate(e, ctx, (c) => `(${ex(e.e, c)} ${e.not ? 'NOT ' : ''}LIKE ${ex(e.pat, c)})`);
      case 'contains': {
        if (e.e.k === 'ref') {
          const r = resolve(e.e.path);
          if (r.k === 'col' && r.col.type === 'tags') {
            const j = `j${aliasN++}`;
            return `(${e.not ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(r.data, ${P(`$."${r.col.id}"`)}) ${j} WHERE lower(${j}.value) = lower(${ex(e.v, ctx)})))`;
          }
        }
        return predicate(e, ctx, (c) => `(${e.not ? 'NOT ' : ''}coalesce(instr(lower(${ex(e.e, c)}), lower(${ex(e.v, c)})), 0) > 0)`);
      }
    }
  };

  const hasAgg = (e: Expr): boolean => {
    if (e.k === 'call' && AGGREGATES.has(e.name)) return true;
    for (const v of Object.values(e)) {
      if (Array.isArray(v) && v.some((y) => y && typeof y === 'object' && 'k' in y && hasAgg(y as Expr))) return true;
      if (v && typeof v === 'object' && !Array.isArray(v) && 'k' in v && hasAgg(v as Expr)) return true;
    }
    return false;
  };

  const items =
    q.items === '*'
      ? table.columns.map((c) => ({ e: { k: 'ref', path: [c.name] } as Expr, alias: null, label: c.name }))
      : q.items;
  const columns = items.map((it) => {
    const label = it.alias ?? (it.e.k === 'ref' ? (resolve(it.e.path).k === 'col' && it.e.path.length === 1 ? (resolve(it.e.path) as { col: Column }).col.name : it.label) : it.label);
    return { name: label, type: typeOf(it.e) };
  });
  const select = items.map((it, i) => `${ex(it.e, top)} AS c${i}`);
  const grouped = q.group.length > 0 || items.some((it) => hasAgg(it.e));
  const withIds = !grouped && !q.distinct;
  if (withIds) select.push('r.id AS _id');
  const where = [`r.table_id = ${P(table.id)}`];
  if (q.where) {
    if (hasAgg(q.where)) throw new QueryError('En WHERE no se puede usar count, sum… (eso va en SELECT)');
    where.push(ex(q.where, top));
  }
  const groupSql = q.group.map((g) => ex(g, top));
  // ORDER BY puede nombrar una columna del resultado por su alias.
  const orderSql = q.order.map((o) => {
    if (o.e.k === 'ref' && o.e.path.length === 1) {
      const i = items.findIndex((it) => it.alias && keyOf(it.alias) === keyOf(o.e.k === 'ref' ? o.e.path[0] : ''));
      if (i >= 0) return `c${i} COLLATE NOCASE${o.desc ? ' DESC' : ''}`;
    }
    if (o.e.k === 'lit' && typeof o.e.v === 'number' && Number.isInteger(o.e.v) && o.e.v >= 1 && o.e.v <= items.length) return `c${o.e.v - 1} COLLATE NOCASE${o.desc ? ' DESC' : ''}`;
    return `${ex(o.e, top)} COLLATE NOCASE${o.desc ? ' DESC' : ''}`;
  });
  if (!orderSql.length && !grouped) orderSql.push('r.position', 'r.id');
  const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const sql = [
    `SELECT ${q.distinct ? 'DISTINCT ' : ''}${select.join(', ')}`,
    'FROM db_rows r',
    `WHERE ${where.join(' AND ')}`,
    groupSql.length ? `GROUP BY ${groupSql.join(', ')}` : '',
    orderSql.length ? `ORDER BY ${orderSql.join(', ')}` : '',
    `LIMIT ${limit + 1}${q.offset ? ` OFFSET ${q.offset}` : ''}`,
  ]
    .filter(Boolean)
    .join(' ');
  return { sql, params, columns, table, withIds, limit };
}

export function runQuery(db: Db, tables: Table[], src: string, today: string): Result {
  const q = parse(src);
  const c = compile(q, tables, today);
  const sqlite = rawOf(db);
  let raw: unknown[][];
  try {
    raw = sqlite.prepare(c.sql).raw(true).all(c.params) as unknown[][];
  } catch (e) {
    throw new QueryError(`La consulta no se pudo hacer: ${(e as Error).message}`);
  }
  const more = raw.length > c.limit;
  if (more) raw = raw.slice(0, c.limit);
  const n = c.columns.length;
  const rows = raw.map((r) =>
    c.columns.map((col, i) => {
      const v = r[i];
      if (col.type === 'list' && typeof v === 'string') {
        try {
          const list = JSON.parse(v);
          return Array.isArray(list) ? list.filter((x) => x !== null).flatMap((x) => (typeof x === 'string' && x.startsWith('[') ? safeList(x) : [x])) : v;
        } catch {
          return v;
        }
      }
      if (col.type === 'checkbox') return v === null ? null : !!v;
      return v;
    }),
  );
  return { table: { id: c.table.id, name: c.table.name }, columns: c.columns, rows, ids: c.withIds ? raw.map((r) => String(r[n])) : null, more };
}

const safeList = (s: string): unknown[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [s];
  } catch {
    return [s];
  }
};
