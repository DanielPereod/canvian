import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ulid } from 'ulidx';
import { api, parseProps, type NoteInput, type NoteRow, type PropertyDef, type PropValue } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { locale, t, tn } from '../i18n';
import { DRAG_TYPE, editedLabel, hueOf, kindOf, snippetOf, titleOf, type Family } from './Biblioteca';
import { Combo, matches, type ComboItem } from './Combo';
import { coverStyle, firstImage, parseCover } from './cover';
import { DatePicker } from './DatePicker';
import { hueOf as optionHue } from './Inspector';
import { LOOSE, type MapAction } from './NodeView';
import { TypeIcon, Value } from './NoteProps';
import { importanceOf } from './sections';
import { ROOT_KEY, sortByOrder, useSidebarPrefs } from './sidebarPrefs';
import { taskCount } from './tasks';
import { longPress, TOUCH } from './touch';
import {
  applyView,
  datable,
  fieldsOf,
  groupable,
  kindName,
  needsValue,
  newView,
  opName,
  OPS,
  saveColl,
  useViews,
  valueOf,
  VIEW_TYPES,
  type Coll,
  type Field,
  type Filter,
  type View,
  type ViewType,
} from './views';

// La colección: las notas que cuelgan de una nota, como una base de datos de
// Notion. Arriba, sus vistas como pestañas (cada una con su forma, filtros,
// orden y propiedades); debajo, las notas en tabla, lista, galería, tablero o
// calendario.

type LibProps = {
  rows: NoteRow[];
  family: Family;
  links: { source: string; target: string }[];
  center: string | null;
  profileId: string;
  defs: PropertyDef[];
  // Antes de las vistas se elegía entre lista y portadas; manda en la vista de partida.
  gallery: boolean;
  paused: boolean;
  lit: Set<string> | null;
  hide: boolean;
  onCenter: (id: string | null) => void;
  onOpen: (id: string) => void;
  onAction: (action: MapAction, noteId: string | null, parentId: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onPatch: (id: string, change: NoteInput) => void;
  onDefsChange: (update: (defs: PropertyDef[]) => PropertyDef[]) => void;
  onError: (err: unknown) => void;
  // Dentro del lector, la nota abierta como colección: vuelve a su texto y Esc
  // es cosa del lector.
  onAsNote?: () => void;
};

const KEYS: Partial<Record<ActionId, MapAction>> = { properties: 'props', deleteCell: 'delete', rename: 'rename', archive: 'archive', move: 'move' };
const LIB_ACTIONS: ActionId[] = ['properties', 'deleteCell', 'rename', 'move', 'archive', 'toRoot', 'newNote', 'newCanvas', 'newSection'];

const isEmpty = (v: PropValue) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

export function Library(p: LibProps) {
  const { kids, count, byId, parent } = p.family;
  const prefs = useSidebarPrefs();
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of p.links) {
      d.set(l.source, (d.get(l.source) ?? 0) + 1);
      d.set(l.target, (d.get(l.target) ?? 0) + 1);
    }
    return d;
  }, [p.links]);

  const here = p.center && p.center !== LOOSE ? (byId.get(p.center) ?? null) : null;
  const base = useMemo(() => {
    let list: NoteRow[];
    if (p.center === LOOSE) list = (kids.get(null) ?? []).filter((r) => !count(r.id));
    // «Todas las notas» son todas de verdad, también las que van dentro de otra.
    else if (!here) list = p.rows;
    else list = kids.get(here.id) ?? [];
    list = list.filter((r) => !p.hide || !p.lit || p.lit.has(r.id));
    const weight = (r: NoteRow) => importanceOf(r, degree.get(r.id) ?? 0) + Math.min(8, count(r.id)) * 0.6;
    // Arriba, las colecciones; después, las más activas: enlaces, tareas abiertas,
    // cambios recientes y largo (o como las ordenaste en la barra).
    const auto = (a: NoteRow, b: NoteRow) => Number(!!count(b.id)) - Number(!!count(a.id)) || weight(b) - weight(a);
    return p.center === LOOSE ? [...list].sort(auto) : sortByOrder(here?.id ?? null, list, auto, prefs);
  }, [p.center, p.rows, p.hide, p.lit, kids, count, here, degree, prefs]);

  // En «Todas las notas», delante del título va dónde está la nota («Casa › Cocina › »).
  const pathOf = (r: NoteRow) => {
    if (p.center !== null) return null;
    const trail = p.family.pathTo(parent.get(r.id) ?? null);
    return trail.length ? <span className="cv-path">{trail.map(titleOf).join(' › ')} › </span> : null;
  };

  // ── Las vistas de esta colección ──
  const fields = useMemo(() => fieldsOf(p.defs), [p.defs]);
  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const key = `${p.profileId}:${p.center === LOOSE ? 'loose' : (here?.id ?? ROOT_KEY)}`;
  const saved = useViews()[key];
  // Sin vistas guardadas, una de partida que solo se guarda al tocarla.
  const starter = useMemo<Coll>(() => ({ active: 'default', views: [{ ...newView(p.gallery ? 'gallery' : 'list', p.defs), id: 'default' }] }), [key, p.gallery]);
  const coll = saved?.views.length ? saved : starter;
  const view = coll.views.find((v) => v.id === coll.active) ?? coll.views[0];
  const save = (next: Coll) => saveColl(key, next);
  const setView = (v: View) => save({ ...coll, views: coll.views.map((x) => (x.id === v.id ? v : x)) });

  const items = useMemo(() => applyView(base, view, fields, count), [base, view, fields, count]);
  const shown = view.fields.map((id) => fieldById.get(id)).filter((f): f is Field => !!f && f.id !== 'title');

  // Cambiar una propiedad desde la tabla, el tablero o el calendario.
  const setField = (r: NoteRow, f: Field, v: PropValue) => {
    if (f.id === 'due') p.onPatch(r.id, { dueAt: typeof v === 'string' && v ? v : null });
    else if (f.def) {
      const { [f.id]: _old, ...rest } = parseProps(r.props);
      p.onPatch(r.id, { props: isEmpty(v) || v === false ? rest : { ...rest, [f.id]: v } });
    }
  };
  const addOption = (def: PropertyDef, option: string) => {
    if (def.options.some((o) => o.toLowerCase() === option.toLowerCase())) return;
    const options = [...def.options, option];
    p.onDefsChange((ds) => ds.map((d) => (d.id === def.id ? { ...d, options } : d)));
    api.updateProperty(def.id, { options }).catch(p.onError);
  };

  // Lo común a filas y portadas: color, arrastrar a la barra y menú con clic derecho.
  const itemProps = (r: NoteRow, i: number) => ({
    style: { '--i': Math.min(i, 20), '--h': hueOf(r.id), ...(prefs.colors[r.id] ? { '--tint': prefs.colors[r.id] } : {}) } as CSSProperties,
    draggable: !TOUCH,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, r.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    ...longPress((x, y) => {
      setSel(i);
      p.onMenu(r.id, x, y);
    }),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setSel(i);
      p.onMenu(r.id, e.clientX, e.clientY);
    },
  });

  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [p.center, view.id]);
  const at = Math.min(sel, Math.max(0, items.length - 1));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [at, view.type]);

  const enter = (r: NoteRow) => (count(r.id) ? p.onCenter(r.id) : p.onOpen(r.id));
  const up = () => (p.center === LOOSE || !here ? p.onCenter(null) : p.onCenter(parent.get(here.id) ?? null));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (p.paused || keysBlocked()) return;
      const el = e.target as HTMLElement | null;
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return;
      const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
      const cols = view.type === 'gallery' ? Math.max(1, Math.round((list.current?.clientWidth ?? 1000) / 200)) : 1;
      const cur = items[at];
      const action = actionFor(e, LIB_ACTIONS);
      if (action && KEYS[action]) {
        if (cur) p.onAction(KEYS[action]!, cur.id, null);
        else if (here) p.onAction(KEYS[action]!, here.id, null);
      } else if (action === 'toRoot') p.onCenter(null);
      else if (action === 'newNote') p.onAction('create', null, here?.id ?? null);
      else if (action === 'newCanvas') p.onAction('createCanvas', null, here?.id ?? null);
      else if (action === 'newSection') p.onAction('section', null, cur?.id ?? here?.id ?? null);
      else if (plain && e.key === 'ArrowDown') setSel(Math.min(items.length - 1, at + cols));
      else if (plain && e.key === 'ArrowUp') setSel(Math.max(0, at - cols));
      else if (plain && e.key === 'ArrowRight' && cols > 1) setSel(Math.min(items.length - 1, at + 1));
      else if (plain && e.key === 'ArrowLeft' && cols > 1) setSel(Math.max(0, at - 1));
      else if (plain && e.key === 'Enter' && cur) enter(cur);
      else if (plain && (e.key === 'Backspace' || e.key === 'Escape') && p.center !== null && !p.onAsNote) up();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const title = p.center === LOOSE ? t('Sueltas') : here ? titleOf(here) : t('Todas las notas');
  const upTitle = here ? p.family.pathTo(parent.get(here.id) ?? null).map(titleOf).join(' / ') || t('Biblioteca') : t('Biblioteca');
  const sortedBy = view.sorts.map((s) => fieldById.get(s.field)?.name).filter(Boolean);
  const how = sortedBy.length ? t('por {fields}', { fields: sortedBy.join(', ') }) : p.center !== LOOSE && prefs.order[here?.id ?? ROOT_KEY]?.length ? t('en tu orden') : t('las más activas primero');
  const hidden = base.length - items.length;

  const dim = (r: NoteRow) => !!p.lit && !p.lit.has(r.id);
  const create = () => p.onAction('create', null, here?.id ?? null);

  return (
    <div className="bib-lib">
      <div className="bib-lib-head">
        <div className="bib-lib-title">
          <span className="bib-muted bib-small">{upTitle}</span>
          <h1>{title}</h1>
        </div>
        <span className="bib-muted bib-lib-count">
          {tn(items.length, '{n} nota', '{n} notas')}
          {hidden > 0 && ` · ${tn(hidden, '{n} oculta por los filtros', '{n} ocultas por los filtros')}`} · {how}
        </span>
        {here &&
          (p.onAsNote ? (
            <button className="bib-link" onClick={p.onAsNote}>
              {t('Ver como nota')}
            </button>
          ) : (
            <button className="bib-link" onClick={() => p.onOpen(here.id)}>
              {t('Abrir «{name}» ↗', { name: titleOf(here) })}
            </button>
          ))}
      </div>
      <ViewBar coll={coll} view={view} fields={fields} defs={p.defs} onSave={save} onView={setView} />
      {items.length === 0 && view.type !== 'calendar' && view.type !== 'board' && (
        <p className="bib-empty">
          {hidden ? (
            t('Ninguna nota cumple los filtros.')
          ) : (
            <>
              {t('Aquí no hay nada todavía.')}
              <span className="bib-keys">
                {' '}
                <kbd>N</kbd> {t('para la primera nota.')}
              </span>
            </>
          )}
        </p>
      )}
      {view.type === 'table' && (
        <div className="cv-table" ref={list} role="table" style={{ '--cv-cols': `minmax(220px, 2.4fr) repeat(${shown.length}, minmax(130px, 1fr))` } as CSSProperties}>
          <div className="cv-tr cv-th" role="row">
            <span role="columnheader" className="cv-th-cell">
              <TypeIcon type="text" />
              {t('Título')}
            </span>
            {shown.map((f) => {
              const s = view.sorts.find((x) => x.field === f.id);
              return (
                <button
                  key={f.id}
                  role="columnheader"
                  className="cv-th-cell"
                  title={t('Ordenar por esta columna')}
                  onClick={() => setView({ ...view, sorts: !s ? [{ field: f.id, dir: 'asc' }] : s.dir === 'asc' ? [{ field: f.id, dir: 'desc' }] : [] })}
                >
                  <TypeIcon type={f.type} />
                  <span className="bib-ellipsis">{f.name}</span>
                  {s && <span className="cv-arrow">{s.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              );
            })}
          </div>
          {items.map((r, i) => (
            <div
              key={r.id}
              role="row"
              className={`cv-tr${i === at ? ' is-sel' : ''}${dim(r) ? ' is-dim' : ''}`}
              style={{ '--i': Math.min(i, 20) } as CSSProperties}
              onMouseEnter={() => setSel(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSel(i);
                p.onMenu(r.id, e.clientX, e.clientY);
              }}
            >
              <button className="cv-td cv-title" role="cell" {...itemProps(r, i)} style={undefined} onClick={() => enter(r)} title={titleOf(r)}>
                <span className={`bib-dot${count(r.id) ? '' : ' is-sub'}`} style={{ '--h': hueOf(r.id), ...(prefs.colors[r.id] ? { '--tint': prefs.colors[r.id] } : {}) } as CSSProperties} aria-hidden="true" />
                <span className="bib-ellipsis">
                  {pathOf(r)}
                  {titleOf(r)}
                </span>
              </button>
              {shown.map((f) => (
                <div key={f.id} role="cell" className={`cv-td${f.editable ? ' is-edit' : ''}`}>
                  {f.id === 'due' ? (
                    <DatePicker className="nprop-input nprop-date" value={r.dueAt?.slice(0, 10) ?? null} placeholder="" onChange={(v) => setField(r, f, v)} />
                  ) : f.def ? (
                    <Value def={f.def} value={valueOf(r, f, count)} autoFocus={false} onChange={(v) => setField(r, f, v)} onAddOption={(o) => addOption(f.def!, o)} />
                  ) : (
                    <Shown r={r} f={f} count={count} />
                  )}
                </div>
              ))}
            </div>
          ))}
          <button className="cv-new" onClick={create}>
            + {t('Nueva')}
          </button>
        </div>
      )}
      {view.type === 'list' && items.length > 0 && (
        <div className="bib-table" ref={list} role="list">
          {items.map((r, i) => {
            const n = count(r.id);
            return (
              <button
                key={r.id}
                role="listitem"
                className={`bib-row cv-row${i === at ? ' is-sel' : ''}${dim(r) ? ' is-dim' : ''}${prefs.colors[r.id] ? ' has-tint' : ''}`}
                {...itemProps(r, i)}
                onMouseEnter={() => setSel(i)}
                onClick={() => enter(r)}
              >
                <Spine row={r} kids={n} />
                <span className="bib-row-main">
                  <span className="bib-row-t">
                    {pathOf(r)}
                    {titleOf(r)}
                  </span>
                  <span className="bib-row-s">{snippetOf(r) || (n ? tn(n, '{n} nota dentro', '{n} notas dentro') : t('Sin texto todavía.'))}</span>
                </span>
                <span className="cv-row-fields">
                  {shown.map((f) => (
                    <span key={f.id} className="cv-row-f" title={f.name}>
                      <Shown r={r} f={f} count={count} />
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {view.type === 'gallery' && (
        <div className="bib-covers" ref={list} role="list">
          {items.map((r, i) => {
            const n = count(r.id);
            const kind = kindOf(r, n);
            const cover = parseCover(r.cover);
            // Con una imagen (la portada o, si no, la primera del texto), la
            // tarjeta es la imagen; sin ella, el resumen del texto.
            const src = cover?.kind === 'image' ? null : firstImage(r.bodyJson);
            const pic = cover?.kind === 'image' ? cover : src ? ({ kind: 'image', src, y: 50 } as const) : null;
            return (
              <button
                key={r.id}
                role="listitem"
                className={`bib-cover-it${i === at ? ' is-sel' : ''}${dim(r) ? ' is-dim' : ''}${prefs.colors[r.id] ? ' has-tint' : ''}`}
                {...itemProps(r, i)}
                onMouseEnter={() => setSel(i)}
                onClick={() => enter(r)}
              >
                {pic ? (
                  <span className={`bib-cover is-pic${n ? ' is-branch' : ''}`}>
                    <span className="bib-cover-img" style={coverStyle(pic)} aria-hidden="true" />
                  </span>
                ) : (
                  <span className={`bib-cover${n ? ' is-branch' : ''}${r.cover ? ' has-cover' : ''}`}>
                    {cover && <span className="bib-cover-img" style={coverStyle(cover)} aria-hidden="true" />}
                    <span className="bib-cover-k">{kind.toLocaleUpperCase(locale())}</span>
                    <span className="bib-cover-t">{titleOf(r)}</span>
                    <span className="bib-cover-s">{snippetOf(r) || (n ? tn(n, '{n} nota dentro', '{n} notas dentro') : '')}</span>
                    <span className="bib-cover-lines" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                )}
                <span className="bib-cover-name">
                  {pathOf(r)}
                  {titleOf(r)}
                </span>
                {shown.length > 0 && (
                  <span className="cv-card-fields">
                    {shown.map((f) => (
                      <Shown key={f.id} r={r} f={f} count={count} quiet />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {view.type === 'board' && (
        <Board
          items={items}
          view={view}
          fields={fields}
          shown={shown}
          count={count}
          sel={items[at]?.id ?? null}
          dim={dim}
          listRef={list}
          onEnter={enter}
          onSel={(id) => setSel(items.findIndex((r) => r.id === id))}
          onMenu={p.onMenu}
          onSet={setField}
        />
      )}
      {view.type === 'calendar' && (
        <Calendar items={items} view={view} fields={fields} sel={items[at]?.id ?? null} dim={dim} listRef={list} onEnter={enter} onMenu={p.onMenu} onSet={setField} onView={setView} count={count} />
      )}
    </div>
  );
}

// El lomo de cada fila: la cuenta de una colección o, si tiene tareas, una
// casilla (llena cuando están todas hechas).
function Spine({ row, kids }: { row: NoteRow; kids: number }) {
  const tasks = taskCount(row);
  const glyph = kids ? String(kids) : tasks.total ? (tasks.open.length ? '□' : '■') : '';
  return (
    <span className={`bib-spine${kids ? ' is-branch' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

// ── Mostrar un valor ──────────────────────────────────────────────────

const dateFmts = new Map<string, Intl.DateTimeFormat>();
export function dayLabel(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const year = y !== new Date().getFullYear();
  const k = `${locale()}:${year}`;
  let f = dateFmts.get(k);
  if (!f) dateFmts.set(k, (f = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) })));
  return f.format(new Date(y, m - 1, d)).replace(/\.(?=\s|$)/g, '');
}

const chip = (o: string) => ({ '--chip': optionHue(o) }) as CSSProperties;

// Un valor tal cual, sin editarlo: en la lista, la galería, el tablero y las
// columnas de la tabla que no se cambian a mano.
function Shown({ r, f, count, quiet }: { r: NoteRow; f: Field; count: (id: string) => number; quiet?: boolean }) {
  const v = valueOf(r, f, count);
  if (isEmpty(v) || v === false) return quiet ? null : <span className="cv-none">—</span>;
  if (f.id === 'kind') return <span className="bib-pill">{kindName(String(v))}</span>;
  if (f.id === 'kids') return <span className="bib-muted">{tn(Number(v), '{n} nota', '{n} notas')}</span>;
  if (f.id === 'tasks') return <span className="bib-muted">{tn(Number(v), '{n} tarea', '{n} tareas')}</span>;
  if (f.id === 'updated') return <span className="bib-muted">{editedLabel(String(v))}</span>;
  switch (f.type) {
    case 'date':
      return <span className="cv-val">{dayLabel(String(v))}</span>;
    case 'checkbox':
      return (
        <span className="cv-val" aria-label={f.name}>
          ✓ {quiet ? f.name : ''}
        </span>
      );
    case 'select':
    case 'tags':
      return (
        <span className="cv-pills">
          {(Array.isArray(v) ? v : [String(v)]).map((o) => (
            <span key={o} className="nprop-pill" style={chip(o)}>
              {o}
            </span>
          ))}
        </span>
      );
    default:
      return <span className="cv-val bib-ellipsis">{String(v)}</span>;
  }
}

// ── Tablero ───────────────────────────────────────────────────────────

const CARD_TYPE = 'application/x-canvian-card';

type BoardProps = {
  items: NoteRow[];
  view: View;
  fields: Field[];
  shown: Field[];
  count: (id: string) => number;
  sel: string | null;
  dim: (r: NoteRow) => boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
  onEnter: (r: NoteRow) => void;
  onSel: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onSet: (r: NoteRow, f: Field, v: PropValue) => void;
};

type Lane = { key: string | boolean | null; label: ReactNode; rows: NoteRow[] };

function lanesOf(items: NoteRow[], g: Field, count: (id: string) => number): Lane[] {
  const lanes: Lane[] = [];
  const add = (key: Lane['key'], label: ReactNode) => {
    const lane: Lane = { key, label, rows: [] };
    lanes.push(lane);
    return lane;
  };
  if (g.type === 'checkbox') {
    const yes = add(true, g.name);
    const no = add(false, t('Sin marcar'));
    for (const r of items) (valueOf(r, g, count) === true ? yes : no).rows.push(r);
    return lanes;
  }
  const byKey = new Map<string, Lane>();
  const laneFor = (o: string) => {
    let lane = byKey.get(o.toLowerCase());
    if (!lane) {
      lane = add(o, g.id === 'kind' ? kindName(o) : o);
      byKey.set(o.toLowerCase(), lane);
    }
    return lane;
  };
  for (const o of g.options) laneFor(o);
  const none = add(null, t('Sin «{name}»', { name: g.name }));
  for (const r of items) {
    const v = valueOf(r, g, count);
    const list = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
    if (!list.length) none.rows.push(r);
    for (const o of list) laneFor(o).rows.push(r);
  }
  // La de «sin valor», al final.
  lanes.splice(lanes.indexOf(none), 1);
  lanes.push(none);
  return lanes.filter((l) => l.rows.length || l.key !== null || g.id !== 'kind');
}

function Board(p: BoardProps) {
  const g = p.fields.find((f) => f.id === p.view.group && groupable(f)) ?? p.fields.find((f) => f.id === 'kind')!;
  const lanes = useMemo(() => lanesOf(p.items, g, p.count), [p.items, g, p.count]);
  const [over, setOver] = useState<string | null>(null);
  const laneId = (k: Lane['key']) => (k === null ? '∅' : String(k));
  const movable = g.editable;

  const drop = (e: React.DragEvent, to: Lane['key']) => {
    e.preventDefault();
    setOver(null);
    let data: { id: string; from: Lane['key'] };
    try {
      data = JSON.parse(e.dataTransfer.getData(CARD_TYPE));
    } catch {
      return;
    }
    const r = p.items.find((x) => x.id === data.id);
    if (!r || data.from === to) return;
    if (g.type === 'checkbox') p.onSet(r, g, to === true);
    else if (g.type === 'select') p.onSet(r, g, to);
    else {
      // Etiquetas: cambia la de la columna de salida por la de llegada.
      const v = valueOf(r, g, p.count);
      const list = (Array.isArray(v) ? v : []).filter((o) => data.from === null || o.toLowerCase() !== String(data.from).toLowerCase());
      p.onSet(r, g, to === null ? list : [...list.filter((o) => o.toLowerCase() !== String(to).toLowerCase()), String(to)]);
    }
  };

  return (
    <div className="cv-board" ref={p.listRef}>
      {lanes.map((lane) => (
        <section
          key={laneId(lane.key)}
          className={`cv-lane${over === laneId(lane.key) ? ' is-over' : ''}`}
          aria-label={typeof lane.label === 'string' ? lane.label : undefined}
          onDragOver={(e) => {
            if (!movable || !e.dataTransfer.types.includes(CARD_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== laneId(lane.key)) setOver(laneId(lane.key));
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null);
          }}
          onDrop={(e) => drop(e, lane.key)}
        >
          <header className="cv-lane-head">
            {lane.key === null || g.type === 'checkbox' || g.id === 'kind' ? (
              <span className="cv-lane-name">{lane.label}</span>
            ) : (
              <span className="nprop-pill" style={chip(String(lane.key))}>
                {lane.label}
              </span>
            )}
            <span className="bib-muted">{lane.rows.length}</span>
          </header>
          <div className="cv-lane-cards">
            {lane.rows.map((r) => (
              <button
                key={r.id}
                className={`cv-card${p.sel === r.id ? ' is-sel' : ''}${p.dim(r) ? ' is-dim' : ''}`}
                draggable={movable && !TOUCH}
                onDragStart={(e) => {
                  e.dataTransfer.setData(CARD_TYPE, JSON.stringify({ id: r.id, from: lane.key }));
                  e.dataTransfer.setData(DRAG_TYPE, r.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onMouseEnter={() => p.onSel(r.id)}
                onClick={() => p.onEnter(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onMenu(r.id, e.clientX, e.clientY);
                }}
                {...longPress((x, y) => p.onMenu(r.id, x, y))}
              >
                <span className="cv-card-t">{titleOf(r)}</span>
                {p.shown.some((f) => f.id !== g.id) && (
                  <span className="cv-card-fields">
                    {p.shown
                      .filter((f) => f.id !== g.id)
                      .map((f) => (
                        <Shown key={f.id} r={r} f={f} count={p.count} quiet />
                      ))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Calendario ────────────────────────────────────────────────────────

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type CalProps = {
  items: NoteRow[];
  view: View;
  fields: Field[];
  count: (id: string) => number;
  sel: string | null;
  dim: (r: NoteRow) => boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
  onEnter: (r: NoteRow) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onSet: (r: NoteRow, f: Field, v: PropValue) => void;
  onView: (v: View) => void;
};

function Calendar(p: CalProps) {
  const f = p.fields.find((x) => x.id === p.view.date && datable(x)) ?? p.fields.find((x) => x.id === 'due')!;
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [over, setOver] = useState<string | null>(null);
  const today = iso(new Date());

  const byDay = useMemo(() => {
    const m = new Map<string, NoteRow[]>();
    for (const r of p.items) {
      const v = valueOf(r, f, p.count);
      if (typeof v !== 'string' || !v) continue;
      // «Editada» va en UTC; se pinta en el día de aquí.
      const d = f.id === 'updated' ? iso(new Date(Date.parse(v))) : v.slice(0, 10);
      const list = m.get(d);
      if (list) list.push(r);
      else m.set(d, [r]);
    }
    return m;
  }, [p.items, f, p.count]);
  const undated = p.items.length - [...byDay.values()].reduce((n, l) => n + l.length, 0);

  // De lunes a domingo, las semanas que toca el mes.
  const first = new Date(month);
  first.setDate(1 - ((month.getDay() + 6) % 7));
  const days: Date[] = [];
  for (let d = new Date(first); days.length < 42; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
    if (days.length % 7 === 0 && d.getMonth() !== month.getMonth() && d >= month) break;
  }
  const title = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(month);
  const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'short' });

  return (
    <div className="cv-cal" ref={p.listRef}>
      <div className="cv-cal-head">
        <span className="cv-cal-title">{title}</span>
        {undated > 0 && <span className="bib-muted bib-small">{tn(undated, '{n} sin fecha', '{n} sin fecha')}</span>}
        <span className="cv-cal-nav">
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t('Mes anterior')}>
            ‹
          </button>
          <button
            onClick={() => {
              const d = new Date();
              setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
          >
            {t('Hoy')}
          </button>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t('Mes siguiente')}>
            ›
          </button>
        </span>
      </div>
      <div className="cv-cal-grid">
        {days.slice(0, 7).map((d) => (
          <span key={`w${d.getDay()}`} className="cv-cal-wd">
            {weekday.format(d).replace(/\.$/, '')}
          </span>
        ))}
        {days.map((d) => {
          const k = iso(d);
          const list = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              className={`cv-day${d.getMonth() !== month.getMonth() ? ' is-out' : ''}${k === today ? ' is-today' : ''}${over === k ? ' is-over' : ''}`}
              onDragOver={(e) => {
                if (!f.editable || !e.dataTransfer.types.includes(CARD_TYPE)) return;
                e.preventDefault();
                if (over !== k) setOver(k);
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                try {
                  const { id } = JSON.parse(e.dataTransfer.getData(CARD_TYPE)) as { id: string };
                  const r = p.items.find((x) => x.id === id);
                  if (r) p.onSet(r, f, k);
                } catch {
                  // Lo que se suelta no es una nota de aquí.
                }
              }}
            >
              <span className="cv-day-n">{d.getDate()}</span>
              {list.map((r) => (
                <button
                  key={r.id}
                  className={`cv-chip${p.sel === r.id ? ' is-sel' : ''}${p.dim(r) ? ' is-dim' : ''}`}
                  title={titleOf(r)}
                  draggable={f.editable && !TOUCH}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(CARD_TYPE, JSON.stringify({ id: r.id }));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => p.onEnter(r)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    p.onMenu(r.id, e.clientX, e.clientY);
                  }}
                >
                  {titleOf(r)}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Las pestañas de las vistas y sus herramientas ─────────────────────

const VIEW_ICONS: Record<ViewType, ReactNode> = {
  table: <path d="M3 4.5h10v7H3zM3 8h10M7 4.5v7" />,
  list: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  gallery: (
    <>
      <rect x="2.8" y="2.8" width="4.4" height="4.4" rx="1" />
      <rect x="8.8" y="2.8" width="4.4" height="4.4" rx="1" />
      <rect x="2.8" y="8.8" width="4.4" height="4.4" rx="1" />
      <rect x="8.8" y="8.8" width="4.4" height="4.4" rx="1" />
    </>
  ),
  board: <path d="M3.5 3v10M8 3v6M12.5 3v8" />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" />
    </>
  ),
};
export const ViewIcon = ({ type }: { type: ViewType }) => (
  <svg className="cv-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {VIEW_ICONS[type]}
  </svg>
);

type Pop = 'filter' | 'sort' | 'fields' | 'view' | 'new';

function ViewBar({ coll, view, fields, defs, onSave, onView }: { coll: Coll; view: View; fields: Field[]; defs: PropertyDef[]; onSave: (c: Coll) => void; onView: (v: View) => void }) {
  const [pop, setPop] = useState<{ kind: Pop; x: number; y: number } | null>(null);
  const open = (kind: Pop) => (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPop((cur) => (cur?.kind === kind ? null : { kind, x: r.left, y: r.bottom + 6 }));
  };
  const add = (type: ViewType) => {
    const v = newView(type, defs);
    onSave({ active: v.id, views: [...coll.views, v] });
  };
  const nFilters = view.filters.length;
  return (
    <div className="cv-bar">
      <div className="cv-tabs" role="tablist" aria-label={t('Vistas')}>
        {coll.views.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={v.id === view.id}
            className={`cv-tab${v.id === view.id ? ' is-on' : ''}`}
            onClick={(e) => (v.id === view.id ? open('view')(e) : onSave({ ...coll, active: v.id }))}
            onContextMenu={(e) => {
              e.preventDefault();
              if (v.id !== view.id) onSave({ ...coll, active: v.id });
              setPop({ kind: 'view', x: e.clientX, y: e.clientY });
            }}
          >
            <ViewIcon type={v.type} />
            <span className="bib-ellipsis">{v.name}</span>
          </button>
        ))}
        <button className="cv-tab cv-tab-add" onClick={open('new')} title={t('Vista nueva')} aria-label={t('Vista nueva')}>
          +
        </button>
      </div>
      <div className="cv-tools">
        <button className={`cv-tool${nFilters ? ' is-on' : ''}`} onClick={open('filter')}>
          {t('Filtrar')}
          {nFilters > 0 && <span className="cv-badge">{nFilters}</span>}
        </button>
        <button className={`cv-tool${view.sorts.length ? ' is-on' : ''}`} onClick={open('sort')}>
          {t('Orden')}
          {view.sorts.length > 0 && <span className="cv-badge">{view.sorts.length}</span>}
        </button>
        <button className="cv-tool" onClick={open('fields')}>
          {t('Propiedades')}
        </button>
        <button className="cv-tool cv-tool-more" onClick={open('view')} aria-label={t('Opciones de la vista')} title={t('Opciones de la vista')}>
          ···
        </button>
      </div>
      {pop && (
        <Popover x={pop.x} y={pop.y} onClose={() => setPop(null)} wide={pop.kind === 'filter' || pop.kind === 'sort'}>
          {pop.kind === 'new' && (
            <>
              <div className="bib-menu-head">{t('Vista nueva')}</div>
              {VIEW_TYPES.map((ty) => (
                <button
                  key={ty.id}
                  className="bib-menu-it cv-menu-it"
                  onClick={() => {
                    setPop(null);
                    add(ty.id);
                  }}
                >
                  <ViewIcon type={ty.id} />
                  {t(ty.name)}
                </button>
              ))}
            </>
          )}
          {pop.kind === 'filter' && <Filters view={view} fields={fields} onView={onView} />}
          {pop.kind === 'sort' && <Sorts view={view} fields={fields} onView={onView} />}
          {pop.kind === 'fields' && <Fields view={view} fields={fields} onView={onView} />}
          {pop.kind === 'view' && (
            <ViewMenu
              coll={coll}
              view={view}
              fields={fields}
              onView={onView}
              onDuplicate={() => {
                const copy: View = { ...view, id: ulid(), name: t('{name} (copia)', { name: view.name }), filters: view.filters.map((f) => ({ ...f, id: ulid() })) };
                const at = coll.views.findIndex((v) => v.id === view.id);
                const views = [...coll.views];
                views.splice(at + 1, 0, copy);
                onSave({ active: copy.id, views });
                setPop(null);
              }}
              onDelete={() => {
                const views = coll.views.filter((v) => v.id !== view.id);
                if (!views.length) return;
                onSave({ active: views[Math.max(0, coll.views.findIndex((v) => v.id === view.id) - 1)].id, views });
                setPop(null);
              }}
              onClose={() => setPop(null)}
            />
          )}
        </Popover>
      )}
    </div>
  );
}

// Ventanita bajo un botón: se cierra con Esc o al pulsar fuera, y mientras
// está abierta las teclas de la biblioteca no se disparan.
function Popover({ x, y, wide, onClose, children }: { x: number; y: number; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState({ x, y });
  useLayoutEffect(() => {
    const place = () => {
      // offsetWidth y no getBoundingClientRect: la entrada la encoge un poco.
      const box = ref.current;
      if (!box) return;
      setSpot({ x: Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8)), y: Math.max(8, Math.min(y, innerHeight - box.offsetHeight - 8)) });
    };
    place();
    // Crece al añadir filtros u órdenes: que siga cabiendo en la pantalla.
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [x, y]);
  useEffect(() => {
    const away = (e: Event) => {
      const el = e.target as HTMLElement;
      // Los menús que abren sus campos (opciones, fechas) van fuera, en el body.
      if (ref.current?.contains(el) || el.closest?.('.bib-menu, .dp-pop, [data-popover]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Con una lista abierta dentro, Esc solo cierra esa lista.
      if (document.querySelector('[data-combo]')) return;
      // Que no llegue a la biblioteca (Esc también es «subir»).
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });
  return createPortal(
    <div ref={ref} className={`bib-menu cv-pop${wide ? ' is-wide' : ''}`} data-keys-modal data-popover style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

const fieldItems = (fields: Field[]): ComboItem[] => fields.map((f) => ({ id: f.id, label: f.name, icon: <TypeIcon type={f.type} /> }));

function Filters({ view, fields, onView }: { view: View; fields: Field[]; onView: (v: View) => void }) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const items = fieldItems(fields);
  // El filtro recién añadido abre ya la lista de propiedades.
  const [fresh, setFresh] = useState<string | null>(null);
  // Y al cambiar de propiedad, la de sus valores.
  const [picked, setPicked] = useState<string | null>(null);
  const set = (id: string, change: Partial<Filter>) => onView({ ...view, filters: view.filters.map((f) => (f.id === id ? { ...f, ...change } : f)) });
  return (
    <div className="cv-rows">
      {view.filters.length > 1 && (
        <div className="cv-match">
          {t('Mostrar las que cumplen')}
          <Combo
            className="is-auto"
            items={[
              { id: 'and', label: t('todos') },
              { id: 'or', label: t('alguno') },
            ]}
            value={view.match}
            onChange={(match) => onView({ ...view, match: match as View['match'] })}
          />
          {t('de estos filtros')}
        </div>
      )}
      {!view.filters.length && <div className="bib-menu-head">{t('Sin filtros: se ven todas las notas.')}</div>}
      {view.filters.map((flt) => {
        const f = byId.get(flt.field);
        return (
          <div key={flt.id} className="cv-row-edit">
            <Combo
              items={items}
              value={flt.field}
              missing={t('(borrada)')}
              label={t('Propiedad')}
            search
              autoOpen={fresh === flt.id}
              onChange={(id) => {
                const nf = byId.get(id);
                if (!nf) return;
                setPicked(flt.id);
                set(flt.id, { field: nf.id, op: OPS[nf.type][0], value: null });
              }}
            />
            {f && <Combo items={OPS[f.type].map((op) => ({ id: op, label: opName(op) }))} value={flt.op} label={t('Condición')} onChange={(op) => set(flt.id, { op })} />}
            {f && needsValue(flt.op) ? <FilterValue key={f.id} f={f} value={flt.value} autoOpen={picked === flt.id} onChange={(value) => set(flt.id, { value })} /> : <span />}
            <button className="cv-x" onClick={() => onView({ ...view, filters: view.filters.filter((x) => x.id !== flt.id) })} aria-label={t('Quitar')} title={t('Quitar')}>
              ×
            </button>
          </div>
        );
      })}
      <button
        className="bib-menu-it cv-add"
        onClick={() => {
          const id = ulid();
          setFresh(id);
          onView({ ...view, filters: [...view.filters, { id, field: 'title', op: 'contains', value: null }] });
        }}
      >
        + {t('Añadir filtro')}
      </button>
    </div>
  );
}

function FilterValue({ f, value, autoOpen, onChange }: { f: Field; value: PropValue; autoOpen: boolean; onChange: (v: PropValue) => void }) {
  if (f.type === 'select' || f.type === 'tags') {
    const current = typeof value === 'string' ? value : null;
    // Un valor que ya no está entre las opciones se sigue viendo para poder cambiarlo.
    const options = current && !f.options.includes(current) ? [current, ...f.options] : f.options;
    return (
      <Combo
        items={options.map((o) => ({ id: o, label: f.id === 'kind' ? kindName(o) : o }))}
        value={current}
        placeholder={t('Elige…')}
        label={t('Valor')}
        search
        autoOpen={autoOpen && !current}
        onChange={(v) => onChange(v || null)}
      />
    );
  }
  if (f.type === 'date') return <DatePicker className="cv-input cv-date" value={typeof value === 'string' ? value : null} placeholder={t('Elige una fecha')} onChange={onChange} />;
  return (
    <input
      className="cv-input"
      type={f.type === 'number' ? 'number' : 'text'}
      value={value === null || value === undefined ? '' : String(value)}
      placeholder={t('Valor')}
      autoFocus
      onChange={(e) => onChange(f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
    />
  );
}

function Sorts({ view, fields, onView }: { view: View; fields: Field[]; onView: (v: View) => void }) {
  const set = (i: number, change: Partial<View['sorts'][number]>) => onView({ ...view, sorts: view.sorts.map((s, j) => (j === i ? { ...s, ...change } : s)) });
  const free = fields.filter((f) => !view.sorts.some((s) => s.field === f.id));
  const [fresh, setFresh] = useState<string | null>(null);
  const dirs: ComboItem[] = [
    { id: 'asc', label: t('Ascendente') },
    { id: 'desc', label: t('Descendente') },
  ];
  return (
    <div className="cv-rows">
      {!view.sorts.length && <div className="bib-menu-head">{t('Sin orden propio: las colecciones arriba y las más activas primero (o como las ordenaste en la barra).')}</div>}
      {view.sorts.map((s, i) => (
        <div key={i} className="cv-row-edit is-sort">
          <Combo
            items={fieldItems(fields.filter((f) => f.id === s.field || free.includes(f)))}
            value={s.field}
            missing={t('(borrada)')}
            label={t('Propiedad')}
            search
            autoOpen={fresh === s.field && i === view.sorts.length - 1}
            onChange={(field) => set(i, { field })}
          />
          <Combo items={dirs} value={s.dir} label={t('Orden')} onChange={(dir) => set(i, { dir: dir as 'asc' | 'desc' })} />
          <button className="cv-x" onClick={() => onView({ ...view, sorts: view.sorts.filter((_, j) => j !== i) })} aria-label={t('Quitar')} title={t('Quitar')}>
            ×
          </button>
        </div>
      ))}
      {free.length > 0 && view.sorts.length < 6 && (
        <button
          className="bib-menu-it cv-add"
          onClick={() => {
            setFresh(free[0].id);
            onView({ ...view, sorts: [...view.sorts, { field: free[0].id, dir: 'asc' }] });
          }}
        >
          + {t('Añadir orden')}
        </button>
      )}
    </div>
  );
}

function Fields({ view, fields, onView }: { view: View; fields: Field[]; onView: (v: View) => void }) {
  const all = fields.filter((f) => f.id !== 'title');
  const on = view.fields.filter((id) => all.some((f) => f.id === id));
  const ordered = [...on.map((id) => all.find((f) => f.id === id)!), ...all.filter((f) => !on.includes(f.id))];
  const [drag, setDrag] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const searching = !!q.trim();
  const list = ordered.filter((f) => matches(f.name, q));
  const toggle = (id: string) => onView({ ...view, fields: on.includes(id) ? on.filter((x) => x !== id) : [...on, id] });
  const move = (id: string, before: string) => {
    if (id === before) return;
    const next = on.filter((x) => x !== id);
    next.splice(next.indexOf(before), 0, id);
    onView({ ...view, fields: next });
  };
  // Con un buscador, «mostrar u ocultar todas» va sobre lo que se ve.
  const ids = list.map((f) => f.id);
  const anyOn = ids.some((id) => on.includes(id));
  const toggleAll = () => onView({ ...view, fields: anyOn ? on.filter((id) => !ids.includes(id)) : [...on, ...ids.filter((id) => !on.includes(id))] });
  return (
    <div className="cv-fields">
      {all.length >= 8 && (
        <input
          className="nprop-menu-input cv-fields-search"
          value={q}
          placeholder={t('Buscar una propiedad…')}
          aria-label={t('Buscar una propiedad…')}
          autoFocus={!TOUCH}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list.length) {
              e.preventDefault();
              toggle(list[0].id);
            }
          }}
        />
      )}
      <div className="bib-menu-head cv-fields-head">
        {t('Propiedades a la vista')}
        {list.length > 0 && (
          <button className="cv-link" onClick={toggleAll}>
            {anyOn ? t('Ocultar todas') : t('Mostrar todas')}
          </button>
        )}
      </div>
      {!list.length && <div className="bib-menu-head">{t('Nada coincide con «{q}»', { q: q.trim() })}</div>}
      {list.map((f) => {
        const visible = on.includes(f.id);
        // Mientras se busca no se reordena: la lista está recortada.
        const grip = visible && !searching;
        return (
          <div
            key={f.id}
            className={`bib-menu-it cv-field${visible ? ' is-on' : ''}${drag === f.id ? ' is-drag' : ''}`}
            draggable={grip && !TOUCH}
            onDragStart={(e) => {
              setDrag(f.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              if (drag && grip) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && grip) move(drag, f.id);
              setDrag(null);
            }}
          >
            <span className="cv-grip" aria-hidden="true">
              {grip ? '⋮⋮' : ''}
            </span>
            <TypeIcon type={f.type} />
            <span className="bib-ellipsis">{f.name}</span>
            <button className={`cv-switch${visible ? ' is-on' : ''}`} role="switch" aria-checked={visible} aria-label={f.name} onClick={() => toggle(f.id)} />
          </div>
        );
      })}
    </div>
  );
}

function ViewMenu({ coll, view, fields, onView, onDuplicate, onDelete, onClose }: { coll: Coll; view: View; fields: Field[]; onView: (v: View) => void; onDuplicate: () => void; onDelete: () => void; onClose: () => void }) {
  const [name, setName] = useState(view.name);
  useEffect(() => setName(view.name), [view.id]);
  const rename = () => {
    const n = name.trim();
    if (n && n !== view.name) onView({ ...view, name: n.slice(0, 60) });
  };
  const groups = fields.filter(groupable);
  const dates = fields.filter(datable);
  return (
    <div className="cv-viewmenu">
      <input
        className="nprop-menu-input"
        value={name}
        aria-label={t('Nombre de la vista')}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            rename();
            onClose();
          }
        }}
      />
      <div className="bib-menu-head">{t('Ver como')}</div>
      <div className="cv-types">
        {VIEW_TYPES.map((ty) => (
          <button
            key={ty.id}
            className={`cv-type${view.type === ty.id ? ' is-on' : ''}`}
            onClick={() =>
              onView({
                ...view,
                type: ty.id,
                group: ty.id === 'board' ? (view.group ?? newView('board', fields.filter((f) => f.def).map((f) => f.def!)).group) : view.group,
                date: ty.id === 'calendar' ? (view.date ?? 'due') : view.date,
              })
            }
          >
            <ViewIcon type={ty.id} />
            {t(ty.name)}
          </button>
        ))}
      </div>
      {view.type === 'board' && (
        <label className="cv-opt">
          {t('Agrupar por')}
          <select className="cv-select" value={view.group ?? 'kind'} onChange={(e) => onView({ ...view, group: e.target.value })}>
            {groups.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {view.type === 'calendar' && (
        <label className="cv-opt">
          {t('Fecha que manda')}
          <select className="cv-select" value={view.date ?? 'due'} onChange={(e) => onView({ ...view, date: e.target.value })}>
            {dates.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="bib-menu-sep" />
      <button className="bib-menu-it" onClick={onDuplicate}>
        {t('Duplicar vista')}
      </button>
      <button className="bib-menu-it is-danger" onClick={onDelete} disabled={coll.views.length < 2} title={coll.views.length < 2 ? t('Es la única vista') : undefined}>
        {t('Borrar vista')}
      </button>
    </div>
  );
}

