import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ulid } from 'ulidx';
import { api, type DbColumn, type DbColumnType, type DbRow, type DbTable, type DbValue } from '../api';
import { locale, t, tn } from '../i18n';
import { Combo } from './Combo';
import { fold } from './Combo';
import { dbTouched, onDbChange } from './dbEvents';
import { hueOf } from './Inspector';

// Las bases de datos: tablas de verdad (no notas), todas juntas en esta vista.
// A la izquierda las tablas del perfil; a la derecha la elegida, como una hoja
// de cálculo: cada columna con su tipo, las relaciones como fichas que llevan
// a filas de otra tabla. Lo que se ve aquí se consulta en las notas con un
// bloque ```db``` y desde las mini apps.

export const COLUMN_TYPES: { id: DbColumnType; name: string; icon: string }[] = [
  { id: 'text', name: 'Texto', icon: 'Aa' },
  { id: 'number', name: 'Número', icon: '#' },
  { id: 'select', name: 'Opciones', icon: '◉' },
  { id: 'tags', name: 'Etiquetas', icon: '⌗' },
  { id: 'date', name: 'Fecha', icon: '▦' },
  { id: 'checkbox', name: 'Casilla', icon: '☑' },
  { id: 'url', name: 'Enlace', icon: '↗' },
  { id: 'image', name: 'Imagen', icon: '◩' },
  { id: 'note', name: 'Nota', icon: '¶' },
  { id: 'relation', name: 'Relación', icon: '⇄' },
];
const typeIcon = (type: DbColumnType) => COLUMN_TYPES.find((x) => x.id === type)?.icon ?? '';

// Cómo se nombra en una consulta (igual que en el servidor).
export const keyOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

type NoteRef = { id: string; title: string };
const FOLDED_KEY = 'canvian.db.folded';
type Props = {
  profileId: string;
  notes: NoteRef[];
  // La tabla abierta al entrar (la última que se miró).
  initial: string | null;
  onTable: (id: string | null) => void;
  onOpenNote: (id: string) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
};

type Sort = { col: string; dir: 1 | -1 } | null;
type Anchor = { x: number; y: number; w: number };
type Pop =
  | { kind: 'cell'; row: string; col: string; at: Anchor }
  | { kind: 'column'; col: string; at: Anchor }
  | { kind: 'addColumn'; at: Anchor }
  | { kind: 'table'; at: Anchor }
  | { kind: 'folder'; at: Anchor }
  | { kind: 'deleteTable'; at: Anchor };

const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4, w: r.width };
};
const empty = (v: DbValue | undefined) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

export function DatabaseView(p: Props) {
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [current, setCurrent] = useState<string | null>(p.initial);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  // Las filas de las tablas a las que apuntan las relaciones (para elegir).
  const [targets, setTargets] = useState<Record<string, DbRow[]>>({});
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [search, setSearch] = useState('');
  const [newTable, setNewTable] = useState<string | null>(null);
  // La carpeta en la que se crea la tabla nueva; y la carpeta que se está creando o renombrando.
  const [newIn, setNewIn] = useState<string | null>(null);
  const [folderEdit, setFolderEdit] = useState<{ from: string | null; name: string } | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleFolder = (name: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
      } catch {
        // Sin almacenamiento local, las carpetas se abren al volver.
      }
      return next;
    });
  const [renaming, setRenaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const table = tables?.find((x) => x.id === current) ?? null;
  const { onError, onTable } = p;

  const loadTables = useCallback(async () => {
    try {
      const list = await api.dbTables(p.profileId);
      setTables(list);
      setCurrent((c) => (c && list.some((x) => x.id === c) ? c : (list[0]?.id ?? null)));
    } catch (e) {
      onError(e);
    }
  }, [p.profileId, onError]);

  const loadRows = useCallback(async () => {
    if (!current) return setRows([]);
    try {
      const r = await api.dbRows(current);
      setRows(r.rows);
      setTitles(r.titles);
    } catch (e) {
      onError(e);
    }
  }, [current, onError]);

  useEffect(() => void loadTables(), [loadTables]);
  useEffect(() => {
    setSort(null);
    setSearch('');
    setEditing(null);
    setRenaming(false);
    void loadRows();
    onTable(current);
  }, [current, loadRows, onTable]);
  useEffect(() => onDbChange(() => void (loadTables(), loadRows())), [loadTables, loadRows]);

  // Las filas de las otras tablas, para las relaciones (al abrir el selector).
  const loadTarget = async (tableId: string) => {
    try {
      const r = await api.dbRows(tableId);
      setTargets((m) => ({ ...m, [tableId]: r.rows }));
    } catch (e) {
      onError(e);
    }
  };

  const touched = () => {
    dbTouched();
    void loadTables();
  };
  const fail = (e: unknown) => {
    onError(e);
    void loadTables();
    void loadRows();
  };

  // ── Cambios ────────────────────────────────────────────────────────

  const setCell = (row: DbRow, col: DbColumn, value: DbValue) => {
    const next = { ...row.values };
    if (empty(value)) delete next[col.id];
    else next[col.id] = value;
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, values: next } : r)));
    api
      .updateDbRow(row.id, { values: { [col.id]: empty(value) ? null : value } })
      .then((saved) => {
        setRows((rs) => rs.map((r) => (r.id === saved.id ? saved : r)));
        if (col.type === 'select' || col.type === 'tags' || col.type === 'relation') void loadTables();
        dbTouched();
      })
      .catch(fail);
  };

  // Una fila nueva al final, arriba del todo o justo debajo de otra.
  const addRow = (where: 'end' | 'top' | { after: string } = 'end', focus = true) => {
    if (!table) return;
    const id = ulid();
    const ordered = [...rows].sort((a, b) => a.position - b.position);
    let position: number;
    if (!ordered.length) position = 1;
    else if (where === 'end') position = ordered[ordered.length - 1].position + 1;
    else if (where === 'top') position = ordered[0].position - 1;
    else {
      const i = ordered.findIndex((r) => r.id === where.after);
      const here = ordered[i]?.position ?? ordered[ordered.length - 1].position;
      const next = ordered[i + 1]?.position;
      position = next === undefined ? here + 1 : (here + next) / 2;
    }
    const row: DbRow = { id, tableId: table.id, position, values: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setRows((rs) => [...rs, row].sort((a, b) => a.position - b.position));
    setSort(null);
    setSearch('');
    if (focus) setEditing({ row: id, col: table.columns[0].id });
    api
      .createDbRow(table.id, { id, position })
      .then(() => touched())
      .catch(fail);
  };

  const deleteRow = (row: DbRow) => {
    setRows((rs) => rs.filter((r) => r.id !== row.id));
    api
      .deleteDbRow(row.id)
      .then(() => touched())
      .catch(fail);
  };

  const createTable = async (name: string) => {
    const clean = name.trim();
    const folder = newIn;
    setNewTable(null);
    setNewIn(null);
    if (!clean) return;
    try {
      const made = await api.createDbTable(p.profileId, { id: ulid(), name: clean, folder });
      setTables((ts) => [...(ts ?? []), { ...made, rows: 0 }]);
      setCurrent(made.id);
      dbTouched();
    } catch (e) {
      onError(e);
    }
  };

  const renameTable = async (name: string) => {
    setRenaming(false);
    if (!table || !name.trim() || name.trim() === table.name) return;
    try {
      await api.updateDbTable(table.id, { name: name.trim() });
      touched();
    } catch (e) {
      fail(e);
    }
  };

  const removeTable = async () => {
    if (!table) return;
    setPop(null);
    try {
      await api.deleteDbTable(table.id);
      setCurrent(null);
      touched();
    } catch (e) {
      fail(e);
    }
  };

  const importCsv = async (file: File) => {
    if (!table) return;
    try {
      const text = await file.text();
      const r = await api.importDbCsv(table.id, text);
      setNotice(t('{rows} filas importadas', { rows: r.rows }) + (r.columns ? ` · ${tn(r.columns, '{n} columna nueva', '{n} columnas nuevas')}` : ''));
      touched();
      void loadRows();
    } catch (e) {
      onError(e);
    }
  };

  const copyQuery = async () => {
    if (!table) return;
    const q = '```db\nSELECT * FROM ' + keyOf(table.name) + '\n```';
    try {
      await navigator.clipboard.writeText(q);
      setNotice(t('Consulta copiada: pégala en una nota'));
    } catch {
      window.prompt(t('Copia la consulta'), q);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  // Esc cierra lo que esté abierto; si no hay nada, la vista.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (pop || editing || newTable !== null || renaming || folderEdit) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Lo que se ve ───────────────────────────────────────────────────

  const shown = useMemo(() => {
    if (!table) return [];
    const q = fold(search.trim());
    let list = rows;
    if (q)
      list = list.filter((r) =>
        table.columns.some((c) => {
          const v = r.values[c.id];
          if (empty(v)) return false;
          const text = c.type === 'relation' && Array.isArray(v) ? v.map((id) => titles[id] ?? '').join(' ') : c.type === 'note' ? (p.notes.find((n) => n.id === v)?.title ?? '') : Array.isArray(v) ? v.join(' ') : String(v);
          return fold(text).includes(q);
        }),
      );
    if (sort) {
      const col = table.columns.find((c) => c.id === sort.col);
      if (col) {
        const keyFor = (r: DbRow): string | number => {
          const v = r.values[col.id];
          if (empty(v)) return '';
          if (col.type === 'number') return Number(v);
          if (col.type === 'checkbox') return v ? 1 : 0;
          if (col.type === 'relation' && Array.isArray(v)) return v.map((id) => titles[id] ?? '').join(', ');
          return Array.isArray(v) ? v.join(', ') : String(v);
        };
        list = [...list].sort((a, b) => {
          const x = keyFor(a);
          const y = keyFor(b);
          // Lo vacío siempre al final.
          if (x === '' && y !== '') return 1;
          if (y === '' && x !== '') return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), locale(), { numeric: true, sensitivity: 'base' })) * sort.dir;
        });
      }
    }
    return list;
  }, [rows, table, search, sort, titles, p.notes]);

  if (!tables) return <div className="tasks-view tv dbv" />;

  // ── Carpetas ───────────────────────────────────────────────────────

  const folders = [...new Set(tables.flatMap((x) => (x.folder ? [x.folder] : [])))].sort((a, b) => a.localeCompare(b, locale(), { numeric: true, sensitivity: 'base' }));

  const moveToFolder = async (folder: string | null) => {
    setPop(null);
    if (!table || (table.folder ?? null) === folder) return;
    setTables((ts) => ts?.map((x) => (x.id === table.id ? { ...x, folder } : x)) ?? ts);
    try {
      await api.updateDbTable(table.id, { folder });
      touched();
    } catch (e) {
      fail(e);
    }
  };

  // Renombrar una carpeta es cambiar la de sus tablas; una carpeta nueva
  // empieza con su primera tabla.
  const saveFolder = async () => {
    const edit = folderEdit;
    setFolderEdit(null);
    const name = edit?.name.trim() ?? '';
    if (!edit || !name) return;
    if (edit.from === null) {
      setNewIn(name);
      setNewTable('');
      return;
    }
    if (name === edit.from) return;
    const ids = tables.filter((x) => x.folder === edit.from).map((x) => x.id);
    setTables((ts) => ts?.map((x) => (ids.includes(x.id) ? { ...x, folder: name } : x)) ?? ts);
    try {
      await Promise.all(ids.map((id) => api.updateDbTable(id, { folder: name })));
      touched();
    } catch (e) {
      fail(e);
    }
  };

  const tableItem = (x: DbTable) => (
    <button key={x.id} className={`tv-nav-item${x.id === current ? ' is-on' : ''}`} onClick={() => setCurrent(x.id)}>
      <span className="tv-nav-icon" aria-hidden="true">
        ▤
      </span>
      <span className="tv-nav-name">{x.name}</span>
      {!!x.rows && <span className="tv-nav-n">{x.rows}</span>}
    </button>
  );

  const newTableInput = (
    <input
      className="dbv-new-table"
      autoFocus
      value={newTable ?? ''}
      placeholder={newIn ? t('Tabla nueva en {folder}', { folder: newIn }) : t('Nombre de la tabla')}
      aria-label={t('Nombre de la tabla')}
      onChange={(e) => setNewTable(e.target.value)}
      onBlur={() => void createTable(newTable ?? '')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void createTable(newTable ?? '');
        if (e.key === 'Escape') {
          e.preventDefault();
          setNewTable(null);
          setNewIn(null);
        }
      }}
    />
  );

  const folderInput = (
    <input
      className="dbv-new-table"
      autoFocus
      value={folderEdit?.name ?? ''}
      placeholder={t('Nombre de la carpeta')}
      aria-label={t('Nombre de la carpeta')}
      onChange={(e) => setFolderEdit((f) => (f ? { ...f, name: e.target.value } : f))}
      onBlur={() => void saveFolder()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void saveFolder();
        if (e.key === 'Escape') {
          e.preventDefault();
          setFolderEdit(null);
        }
      }}
    />
  );

  return (
    <div className="tasks-view tv dbv">
      <nav className="tv-side" aria-label={t('Tablas')}>
        <div className="tv-side-title dbv-side-title">{t('Bases de datos')}</div>
        {tables.filter((x) => !x.folder).map(tableItem)}
        {newTable !== null && newIn === null && newTableInput}
        {folders.map((f) => (
          <div key={f} className="dbv-folder">
            {folderEdit && folderEdit.from === f ? (
              folderInput
            ) : (
              <div className="dbv-folder-head">
                <button className="tv-nav-item dbv-folder-name" onClick={() => toggleFolder(f)} aria-expanded={!folded.has(f)}>
                  <span className="tv-nav-icon" aria-hidden="true">
                    {folded.has(f) ? '▸' : '▾'}
                  </span>
                  <span className="tv-nav-name">{f}</span>
                </button>
                <button className="dbv-folder-tool" onClick={() => setFolderEdit({ from: f, name: f })} aria-label={t('Cambiar el nombre de la carpeta')} title={t('Cambiar el nombre de la carpeta')}>
                  ✎
                </button>
                <button
                  className="dbv-folder-tool"
                  onClick={() => {
                    if (folded.has(f)) toggleFolder(f);
                    setNewIn(f);
                    setNewTable('');
                  }}
                  aria-label={t('Nueva tabla en {folder}', { folder: f })}
                  title={t('Nueva tabla en {folder}', { folder: f })}
                >
                  +
                </button>
              </div>
            )}
            {!folded.has(f) && (
              <div className="dbv-folder-items">
                {tables.filter((x) => x.folder === f).map(tableItem)}
                {newTable !== null && newIn === f && newTableInput}
              </div>
            )}
          </div>
        ))}
        {folderEdit && folderEdit.from === null && folderInput}
        {newTable !== null && newIn !== null && !folders.includes(newIn) && (
          <div className="dbv-folder">
            <div className="tv-nav-item dbv-folder-name is-new">
              <span className="tv-nav-icon" aria-hidden="true">
                ▾
              </span>
              <span className="tv-nav-name">{newIn}</span>
            </div>
            <div className="dbv-folder-items">{newTableInput}</div>
          </div>
        )}
        {newTable !== null ? null : (
          <button className="tv-nav-item dbv-add-table" onClick={() => setNewTable('')}>
            <span className="tv-nav-icon" aria-hidden="true">
              +
            </span>
            <span className="tv-nav-name">{t('Nueva tabla')}</span>
          </button>
        )}
        {!folderEdit && (
          <button className="tv-nav-item dbv-add-table" onClick={() => setFolderEdit({ from: null, name: '' })}>
            <span className="tv-nav-icon" aria-hidden="true">
              ▸
            </span>
            <span className="tv-nav-name">{t('Nueva carpeta')}</span>
          </button>
        )}
      </nav>

      <main className="tv-main dbv-main">
        {!table ? (
          <div className="dbv-empty">
            <p className="dbv-empty-title">{t('Aún no hay tablas')}</p>
            <p className="dbv-empty-text">{t('Como una hoja de cálculo con columnas de tipos (número, fecha, opciones…) que se enlazan entre sí: libros y autores, gastos y meses, recetas e ingredientes. Luego puedes enseñarlas dentro de cualquier nota.')}</p>
            <button className="btn btn-primary btn-sm" onClick={() => setNewTable('')}>
              {t('Crear la primera tabla')}
            </button>
          </div>
        ) : (
          <>
            <header className="tv-head">
              <h1 className="tv-title">
                {renaming ? (
                  <input
                    className="dbv-rename"
                    autoFocus
                    defaultValue={table.name}
                    aria-label={t('Nombre de la tabla')}
                    onBlur={(e) => void renameTable(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void renameTable(e.currentTarget.value);
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenaming(false);
                      }
                    }}
                  />
                ) : (
                  <button className="dbv-title" onClick={() => setRenaming(true)} title={t('Cambiar el nombre')}>
                    {table.name}
                  </button>
                )}
                <span className="tv-count">{rows.length}</span>
              </h1>
              <div className="tv-head-tools dbv-tools">
                <input className="dbv-search" type="search" value={search} placeholder={t('Buscar en la tabla')} aria-label={t('Buscar en la tabla')} onChange={(e) => setSearch(e.target.value)} />
                <button className="btn btn-primary btn-sm" onClick={() => addRow('top')} title={t('Añadir una fila arriba del todo')}>
                  + {t('Fila')}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={(e) => setPop({ kind: 'table', at: anchorOf(e.currentTarget) })} aria-haspopup="menu">
                  {t('Más')} ▾
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void importCsv(f);
                  }}
                />
              </div>
            </header>

            <div className="dbv-grid-wrap">
              <table className="dbv-grid">
                <thead>
                  <tr>
                    {table.columns.map((c) => (
                      <th key={c.id} className={c.options.primary ? 'is-primary' : undefined}>
                        <button className="dbv-th" onClick={(e) => setPop({ kind: 'column', col: c.id, at: anchorOf(e.currentTarget) })} title={`${t(COLUMN_TYPES.find((x) => x.id === c.type)?.name ?? '')} · ${keyOf(c.name)}`}>
                          <span className="dbv-th-icon" aria-hidden="true">
                            {typeIcon(c.type)}
                          </span>
                          <span className="dbv-th-name">{c.name}</span>
                          {sort?.col === c.id && <span className="dbv-th-sort">{sort.dir === 1 ? '↑' : '↓'}</span>}
                        </button>
                      </th>
                    ))}
                    <th className="dbv-th-add">
                      <button className="dbv-th" onClick={(e) => setPop({ kind: 'addColumn', at: anchorOf(e.currentTarget) })} aria-label={t('Añadir columna')} title={t('Añadir columna')}>
                        +
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      {table.columns.map((c) => (
                        <td key={c.id} className={`dbv-td is-${c.type}${c.options.primary ? ' is-primary' : ''}`}>
                          <Cell
                            col={c}
                            row={r}
                            titles={titles}
                            notes={p.notes}
                            editing={editing?.row === r.id && editing.col === c.id}
                            onEdit={(el) => {
                              if (['select', 'tags', 'relation', 'note'].includes(c.type)) {
                                if (c.type === 'relation' && c.options.target) void loadTarget(c.options.target);
                                setPop({ kind: 'cell', row: r.id, col: c.id, at: anchorOf(el) });
                              } else setEditing({ row: r.id, col: c.id });
                            }}
                            onDone={() => setEditing(null)}
                            onChange={(v) => setCell(r, c, v)}
                            onOpenNote={p.onOpenNote}
                            onNext={() => {
                              const i = table.columns.findIndex((x) => x.id === c.id);
                              const next = table.columns.slice(i + 1).find((x) => !['select', 'tags', 'relation', 'note', 'checkbox'].includes(x.type));
                              setEditing(next ? { row: r.id, col: next.id } : null);
                            }}
                          />
                        </td>
                      ))}
                      <td className="dbv-td-tools">
                        <button className="dbv-row-add" onClick={() => addRow({ after: r.id })} aria-label={t('Añadir una fila debajo')} title={t('Añadir una fila debajo')}>
                          +
                        </button>
                        <button className="dbv-row-del" onClick={() => deleteRow(r)} aria-label={t('Borrar la fila')} title={t('Borrar la fila')}>
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!shown.length && search && <p className="dbv-none">{t('Ninguna fila tiene «{q}»', { q: search })}</p>}
              <button className="dbv-add-row" onClick={() => addRow('end')}>
                + {t('Nueva fila')}
              </button>
            </div>
          </>
        )}
        {notice && (
          <div className="toast dbv-toast" role="status">
            {notice}
          </div>
        )}
      </main>

      {pop && table && (
        <Popup at={pop.at} onClose={() => setPop(null)} wide={pop.kind !== 'table'}>
          {pop.kind === 'table' && (
            <ul className="list" role="menu">
              <MenuItem
                icon="⧉"
                label={t('Copiar consulta para una nota')}
                onClick={() => {
                  setPop(null);
                  void copyQuery();
                }}
              />
              <MenuItem
                icon="↓"
                label={t('Exportar CSV')}
                onClick={() => {
                  setPop(null);
                  const a = document.createElement('a');
                  a.href = `/api/db/tables/${table.id}/csv`;
                  a.download = `${table.name}.csv`;
                  a.click();
                }}
              />
              <MenuItem
                icon="↑"
                label={t('Importar CSV…')}
                onClick={() => {
                  setPop(null);
                  fileRef.current?.click();
                }}
              />
              <MenuItem icon="▸" label={t('Mover a una carpeta…')} onClick={() => setPop({ kind: 'folder', at: pop.at })} />
              <MenuItem
                icon="✎"
                label={t('Cambiar el nombre')}
                onClick={() => {
                  setPop(null);
                  setRenaming(true);
                }}
              />
              <MenuItem icon="🗑" label={t('Borrar la tabla')} danger onClick={() => setPop({ kind: 'deleteTable', at: pop.at })} />
            </ul>
          )}
          {/* Se confirma aquí y no con window.confirm, que en algunos navegadores y en la app no sale. */}
          {pop.kind === 'deleteTable' && (
            <Confirm
              text={t('¿Borrar la tabla «{name}» con sus {n} filas? Las relaciones de otras tablas con ella también se borran.', { name: table.name, n: rows.length })}
              onCancel={() => setPop(null)}
              onConfirm={() => void removeTable()}
            />
          )}
          {pop.kind === 'folder' && (
            <Picker
              multi={false}
              items={folders.map((f) => ({ id: f, label: f }))}
              value={table.folder ? [table.folder] : []}
              placeholder={t('Buscar o crear una carpeta')}
              onCreate={(name) => void moveToFolder(name)}
              onChange={(ids) => void moveToFolder(ids[0] ?? null)}
            />
          )}
          {pop.kind === 'addColumn' && (
            <ColumnForm
              tables={tables}
              table={table}
              onCancel={() => setPop(null)}
              onSave={async (body) => {
                setPop(null);
                try {
                  await api.createDbColumn(table.id, { id: ulid(), ...body });
                  touched();
                } catch (e) {
                  fail(e);
                }
              }}
            />
          )}
          {pop.kind === 'column' &&
            (() => {
              const col = table.columns.find((c) => c.id === pop.col);
              if (!col) return null;
              return (
                <ColumnForm
                  tables={tables}
                  table={table}
                  col={col}
                  sort={sort?.col === col.id ? sort.dir : 0}
                  onSort={(dir) => {
                    setSort(dir ? { col: col.id, dir } : null);
                    setPop(null);
                  }}
                  onCancel={() => setPop(null)}
                  deleteText={(() => {
                    const pair = col.type === 'relation' ? tables.flatMap((x) => x.columns).find((x) => x.id === col.options.pair) : null;
                    const extra = pair ? ' ' + t('También se borra «{col}» de «{table}».', { col: pair.name, table: tables.find((x) => x.id === pair.tableId)?.name ?? '' }) : '';
                    return t('¿Borrar la columna «{name}» y sus valores?', { name: col.name }) + extra;
                  })()}
                  onDelete={async () => {
                    setPop(null);
                    try {
                      await api.deleteDbColumn(col.id);
                      touched();
                      void loadRows();
                    } catch (e) {
                      fail(e);
                    }
                  }}
                  onSave={async (body) => {
                    setPop(null);
                    const patch: { name?: string; type?: DbColumnType } = {};
                    if (body.name !== col.name) patch.name = body.name;
                    if (body.type !== col.type) patch.type = body.type;
                    if (!Object.keys(patch).length) return;
                    try {
                      await api.updateDbColumn(col.id, patch);
                      touched();
                      void loadRows();
                    } catch (e) {
                      fail(e);
                    }
                  }}
                />
              );
            })()}
          {pop.kind === 'cell' &&
            (() => {
              const col = table.columns.find((c) => c.id === pop.col);
              const row = rows.find((r) => r.id === pop.row);
              if (!col || !row) return null;
              const value = row.values[col.id];
              if (col.type === 'note') {
                return (
                  <Picker
                    multi={false}
                    items={p.notes.map((n) => ({ id: n.id, label: n.title }))}
                    value={typeof value === 'string' ? [value] : []}
                    placeholder={t('Buscar una nota')}
                    onChange={(ids) => {
                      setCell(row, col, ids[0] ?? null);
                      setPop(null);
                    }}
                  />
                );
              }
              if (col.type === 'relation') {
                const target = tables.find((x) => x.id === col.options.target);
                const prim = target?.columns.find((c) => c.options.primary) ?? target?.columns[0];
                const list = targets[col.options.target ?? ''] ?? [];
                const ids = Array.isArray(value) ? value : [];
                return (
                  <Picker
                    multi
                    items={list.map((x) => ({ id: x.id, label: String(x.values[prim?.id ?? ''] ?? '') || t('Sin nombre') }))}
                    value={ids}
                    placeholder={target ? t('Buscar en {table}', { table: target.name }) : ''}
                    loading={!targets[col.options.target ?? '']}
                    onCreate={
                      target && prim
                        ? async (label) => {
                            const id = ulid();
                            try {
                              await api.createDbRow(target.id, { id, values: { [prim.id]: label } });
                              setTitles((m) => ({ ...m, [id]: label }));
                              setTargets((m) => ({ ...m, [target.id]: [...(m[target.id] ?? []), { id, tableId: target.id, position: 0, values: { [prim.id]: label }, createdAt: '', updatedAt: '' }] }));
                              setCell(row, col, [...ids, id]);
                            } catch (e) {
                              onError(e);
                            }
                          }
                        : undefined
                    }
                    onChange={(next) => {
                      const names = Object.fromEntries(list.map((x) => [x.id, String(x.values[prim?.id ?? ''] ?? '')]));
                      setTitles((m) => ({ ...m, ...names }));
                      setCell(row, col, next);
                    }}
                  />
                );
              }
              const multi = col.type === 'tags';
              const current = multi ? (Array.isArray(value) ? value : []) : typeof value === 'string' ? [value] : [];
              return (
                <Picker
                  multi={multi}
                  colored
                  items={(col.options.choices ?? []).map((c) => ({ id: c, label: c }))}
                  value={current}
                  placeholder={t('Buscar o crear una opción')}
                  onCreate={(label) => {
                    setCell(row, col, multi ? [...current, label] : label);
                    if (!multi) setPop(null);
                  }}
                  onChange={(next) => {
                    setCell(row, col, multi ? next : (next[next.length - 1] ?? null));
                    if (!multi) setPop(null);
                  }}
                />
              );
            })()}
        </Popup>
      )}
    </div>
  );
}

// ── Celdas ────────────────────────────────────────────────────────────

const fmtDate = (v: string) => {
  const d = new Date(v.length === 10 ? `${v}T12:00:00` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtNumber = (v: DbValue) => (typeof v === 'number' ? v.toLocaleString(locale(), { maximumFractionDigits: 6 }) : String(v));

function Chip({ label, colored }: { label: string; colored?: boolean }) {
  return (
    <span className="dbv-chip" style={colored ? ({ '--chip': hueOf(label) } as CSSProperties) : undefined}>
      {label}
    </span>
  );
}

function Cell(p: {
  col: DbColumn;
  row: DbRow;
  titles: Record<string, string>;
  notes: NoteRef[];
  editing: boolean;
  onEdit: (el: HTMLElement) => void;
  onDone: () => void;
  onChange: (v: DbValue) => void;
  onOpenNote: (id: string) => void;
  onNext: () => void;
}) {
  const { col, row } = p;
  const value = row.values[col.id];
  if (col.type === 'checkbox')
    return (
      <label className="dbv-check">
        <input type="checkbox" checked={value === true} onChange={(e) => p.onChange(e.target.checked ? true : null)} aria-label={col.name} />
      </label>
    );
  if (p.editing && ['text', 'number', 'date', 'url', 'image'].includes(col.type)) return <CellInput col={col} value={value} onDone={p.onDone} onChange={p.onChange} onNext={p.onNext} />;
  let content: ReactNode = null;
  if (!empty(value)) {
    switch (col.type) {
      case 'number':
        content = fmtNumber(value!);
        break;
      case 'date':
        content = fmtDate(String(value));
        break;
      case 'url':
        content = (
          <a href={String(value)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {String(value).replace(/^https?:\/\/(www\.)?/, '')}
          </a>
        );
        break;
      case 'image':
        content = /^(https?:\/\/|\/api\/media\/)/.test(String(value)) ? <img className="dbv-img" src={String(value)} alt="" loading="lazy" /> : String(value);
        break;
      case 'select':
        content = <Chip label={String(value)} colored />;
        break;
      case 'tags':
        content = (value as string[]).map((x) => <Chip key={x} label={x} colored />);
        break;
      case 'relation':
        content = (value as string[]).map((id) => <Chip key={id} label={p.titles[id] || t('Sin nombre')} />);
        break;
      case 'note': {
        const n = p.notes.find((x) => x.id === value);
        content = (
          <a
            href="#"
            className="dbv-note"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (n) p.onOpenNote(n.id);
            }}
          >
            {n ? n.title : t('Nota borrada')}
          </a>
        );
        break;
      }
      default:
        content = String(value);
    }
  }
  return (
    <div
      className="dbv-cell"
      role="button"
      tabIndex={0}
      onClick={(e) => p.onEdit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          p.onEdit(e.currentTarget);
        }
      }}
    >
      {content ?? <span className="dbv-blank" />}
    </div>
  );
}

function CellInput({ col, value, onDone, onChange, onNext }: { col: DbColumn; value: DbValue | undefined; onDone: () => void; onChange: (v: DbValue) => void; onNext: () => void }) {
  const initial = value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(col.type === 'date' ? initial.slice(0, 10) : initial);
  const done = useRef(false);
  const commit = (next?: () => void) => {
    if (done.current) return;
    done.current = true;
    const clean = text.trim();
    if (clean !== initial.trim()) {
      if (col.type === 'number') {
        const n = Number(clean.replace(/\s/g, '').replace(',', '.'));
        onChange(clean && Number.isFinite(n) ? n : null);
      } else onChange(clean || null);
    }
    if (next) next();
    else onDone();
  };
  return (
    <input
      className="dbv-input"
      autoFocus
      type={col.type === 'date' ? 'date' : 'text'}
      inputMode={col.type === 'number' ? 'decimal' : col.type === 'url' ? 'url' : undefined}
      value={text}
      aria-label={col.name}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          commit(onNext);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onDone();
        }
      }}
    />
  );
}

// ── Ventanitas ────────────────────────────────────────────────────────

function Popup({ at, onClose, wide, children }: { at: Anchor; onClose: () => void; wide: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8));
    const top = at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.y - r.height - 40) : at.y;
    // Se mide cada vez: lo de dentro cambia (un menú que pasa a pedir confirmación).
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`surface-3 dbv-pop${wide ? ' is-wide' : ''}`} style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <li role="menuitem" tabIndex={0} className={`list-item dbv-menu-item${danger ? ' is-danger' : ''}`} onClick={onClick} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="list-icon" aria-hidden="true">
        {icon}
      </span>
      {label}
    </li>
  );
}

function Picker(p: { items: { id: string; label: string }[]; value: string[]; multi: boolean; colored?: boolean; placeholder: string; loading?: boolean; onChange: (ids: string[]) => void; onCreate?: (label: string) => void }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const list = useMemo(() => {
    const f = fold(q.trim());
    const hits = p.items.filter((x) => !f || fold(x.label).includes(f));
    // Lo elegido, arriba.
    return [...hits.filter((x) => p.value.includes(x.id)), ...hits.filter((x) => !p.value.includes(x.id))].slice(0, 200);
  }, [p.items, p.value, q]);
  const canCreate = !!p.onCreate && !!q.trim() && !p.items.some((x) => fold(x.label) === fold(q.trim()));
  const toggle = (id: string) => {
    const on = p.value.includes(id);
    p.onChange(p.multi ? (on ? p.value.filter((x) => x !== id) : [...p.value, id]) : on ? [] : [id]);
  };
  const total = list.length + (canCreate ? 1 : 0);
  return (
    <div className="dbv-picker">
      <input
        className="dbv-picker-search"
        autoFocus
        value={q}
        placeholder={p.placeholder}
        aria-label={p.placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAt((i) => Math.min(total - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (at < list.length) toggle(list[at].id);
            else if (canCreate) {
              p.onCreate!(q.trim());
              setQ('');
            }
          }
        }}
      />
      <ul className="list" role="listbox" aria-multiselectable={p.multi}>
        {p.loading && <li className="list-item static">{t('Cargando…')}</li>}
        {!p.loading && !list.length && !canCreate && <li className="list-item static">{p.items.length ? t('Nada coincide') : t('Aún no hay nada que elegir')}</li>}
        {list.map((x, i) => (
          <li key={x.id} role="option" aria-selected={i === at} className="list-item dbv-pick" onMouseEnter={() => setAt(i)} onClick={() => toggle(x.id)}>
            <span className={`dbv-pick-mark${p.value.includes(x.id) ? ' is-on' : ''}`} aria-hidden="true">
              {p.value.includes(x.id) ? '✓' : ''}
            </span>
            {p.colored ? <Chip label={x.label} colored /> : <span className="dbv-pick-label">{x.label}</span>}
          </li>
        ))}
        {canCreate && (
          <li
            role="option"
            aria-selected={at === list.length}
            className="list-item dbv-pick"
            onMouseEnter={() => setAt(list.length)}
            onClick={() => {
              p.onCreate!(q.trim());
              setQ('');
            }}
          >
            <span className="dbv-pick-mark" aria-hidden="true">
              +
            </span>
            {t('Crear «{name}»', { name: q.trim() })}
          </li>
        )}
      </ul>
    </div>
  );
}

function ColumnForm(p: {
  tables: DbTable[];
  table: DbTable;
  col?: DbColumn;
  sort?: number;
  onSort?: (dir: 1 | -1 | 0) => void;
  onCancel: () => void;
  onDelete?: () => void;
  deleteText?: string;
  onSave: (body: { name: string; type: DbColumnType; target?: string }) => void;
}) {
  const [name, setName] = useState(p.col?.name ?? '');
  const [type, setType] = useState<DbColumnType>(p.col?.type ?? 'text');
  const [target, setTarget] = useState<string | null>(p.col?.options.target ?? p.tables.find((x) => x.id !== p.table.id)?.id ?? p.table.id);
  const primary = !!p.col?.options.primary;
  const [confirming, setConfirming] = useState(false);
  const relation = p.col?.type === 'relation';
  const save = () => {
    if (!name.trim()) return;
    p.onSave({ name: name.trim(), type, ...(type === 'relation' && target ? { target } : {}) });
  };
  // Lo que admite cambiar de tipo: la principal es siempre texto y una relación no se convierte.
  const types = primary ? COLUMN_TYPES.filter((x) => x.id === 'text') : relation ? COLUMN_TYPES.filter((x) => x.id === 'relation') : p.col ? COLUMN_TYPES.filter((x) => x.id !== 'relation') : COLUMN_TYPES;
  const targetName = p.tables.find((x) => x.id === p.col?.options.target)?.name;
  return (
    <form
      className="dbv-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="dbv-field">
        <span>{t('Nombre')}</span>
        <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      {name.trim() && keyOf(name) !== name.trim() && <span className="dbv-hint">{t('En las consultas: {key}', { key: keyOf(name) })}</span>}
      <label className="dbv-field">
        <span>{t('Tipo')}</span>
        <Combo items={types.map((x) => ({ id: x.id, label: t(x.name), icon: x.icon }))} value={type} onChange={(v) => setType(v as DbColumnType)} disabled={types.length < 2} />
      </label>
      {type === 'relation' && !p.col && (
        <label className="dbv-field">
          <span>{t('Con la tabla')}</span>
          <Combo items={p.tables.map((x) => ({ id: x.id, label: x.name }))} value={target} onChange={setTarget} />
        </label>
      )}
      {relation && targetName && <span className="dbv-hint">{t('Enlaza con filas de «{table}»', { table: targetName })}</span>}
      {p.col && type !== p.col.type && <span className="dbv-hint">{t('Los valores que se puedan se pasan al tipo nuevo; los demás se vacían.')}</span>}
      {p.onSort && (
        <div className="dbv-sort">
          <button type="button" className={`btn btn-ghost btn-sm${p.sort === 1 ? ' is-on' : ''}`} onClick={() => p.onSort!(p.sort === 1 ? 0 : 1)}>
            ↑ {t('Ascendente')}
          </button>
          <button type="button" className={`btn btn-ghost btn-sm${p.sort === -1 ? ' is-on' : ''}`} onClick={() => p.onSort!(p.sort === -1 ? 0 : -1)}>
            ↓ {t('Descendente')}
          </button>
        </div>
      )}
      {confirming && p.onDelete ? (
        <Confirm text={p.deleteText ?? ''} onCancel={() => setConfirming(false)} onConfirm={p.onDelete} />
      ) : (
      <div className="dbv-form-actions">
        {p.onDelete && !primary && (
          <button type="button" className="btn btn-ghost btn-sm dbv-danger" onClick={() => setConfirming(true)}>
            {t('Borrar')}
          </button>
        )}
        <span className="dbv-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={p.onCancel}>
          {t('Cancelar')}
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
          {p.col ? t('Guardar') : t('Añadir')}
        </button>
      </div>
      )}
    </form>
  );
}

function Confirm({ text, onCancel, onConfirm }: { text: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="dbv-confirm" role="alertdialog" aria-label={text}>
      <p className="dbv-confirm-text">{text}</p>
      <div className="dbv-form-actions">
        <span className="dbv-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t('Cancelar')}
        </button>
        <button type="button" className="btn btn-primary btn-sm dbv-danger-solid" autoFocus onClick={onConfirm}>
          {t('Borrar')}
        </button>
      </div>
    </div>
  );
}
