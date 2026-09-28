import { useEffect, useMemo, useRef, useState } from 'react';
import { parentMap } from './sections';
import type { NoteInput, NoteRow, TaskStatus } from '../api';
import { daysUntil, dueLabel, localToday } from './dates';
import { actionFor, keysBlocked } from '../keys';
import { BackArrow } from '../BackArrow';
import { mergeTags, splitTags } from './tags';

// Vista de tareas, fuera del mapa, en tres columnas: a la izquierda las
// listas (Hoy, 7 días, rápidas, por nota madre y por etiqueta), en el centro
// las tareas de la elegida y a la derecha el detalle de la señalada.
// Las tareas rápidas se apuntan arriba y solo viven aquí, sin nota detrás.

export type TaskGrouping = 'estado' | 'seccion' | 'fecha';
const GROUPINGS: { id: TaskGrouping; label: string }[] = [
  { id: 'fecha', label: 'Fecha' },
  { id: 'estado', label: 'Estado' },
  { id: 'seccion', label: 'Dentro de' },
];
const STATUSES: { id: TaskStatus; name: string }[] = [
  { id: 'todo', name: 'Pendiente' },
  { id: 'doing', name: 'En curso' },
  { id: 'blocked', name: 'Bloqueada' },
  { id: 'done', name: 'Hecha' },
];
const PRIOS = ['Sin prioridad', 'Baja', 'Media', 'Alta'];
const GROUP_KEY = 'canvian.tasksGrouping';
const VIEW_KEY = 'canvian.tasksView';

const read = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Sin almacenamiento local no se recuerda, sin más.
  }
};

// Lo que más urge arriba: en curso, vencida o cerca, prioridad, lo último tocado.
const urgency = (r: NoteRow) =>
  (r.status === 'doing' ? 1000 : r.status === 'blocked' ? -1000 : 0) +
  (r.dueAt ? 400 - Math.max(-30, Math.min(60, daysUntil(r.dueAt))) * 5 : 0) +
  (r.priority ?? 0) * 60 +
  (r.updatedAt ? Date.parse(r.updatedAt) / 1e11 : 0);

const WEEKDAY = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });
function whenGroup(r: NoteRow): [number, string] {
  if (!r.dueAt) return [9, 'Sin fecha'];
  const d = daysUntil(r.dueAt);
  if (d < 0) return [0, 'Vencidas'];
  if (d === 0) return [1, `${cap(WEEKDAY.format(new Date(localToday())))}, hoy`];
  if (d === 1) return [2, 'Mañana'];
  if (d <= 7) return [3, 'Próximos 7 días'];
  if (d <= 31) return [4, 'Este mes'];
  return [5, 'Más adelante'];
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isoDay = (offset: number) => {
  const t = new Date(localToday());
  return isoOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset));
};
const titleOf = (r: NoteRow) => r.title || 'Tarea sin título';
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTH = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const DOW = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

type Props = {
  rows: NoteRow[];
  quick: NoteRow[];
  onOpen: (id: string) => void;
  onCycle: (id: string) => void;
  onBlock: (id: string) => void;
  onPatch: (id: string, change: NoteInput) => void;
  onRename: (id: string, title: string) => void;
  onAddQuick: (raw: string, extra?: { dueAt?: string }) => void;
  onAddTask: (raw: string, zoneId: string) => void;
  onEditQuick: (id: string, title: string) => void;
  onDeleteQuick: (id: string) => void;
  tagsOf: (r: NoteRow) => string[];
  onSetTags: (r: NoteRow, tags: string[]) => void;
  onClose: () => void;
  /** A dónde vuelve «←»: el mapa o la lista de Foco. */
  back: string;
  paused: boolean;
};

export function TasksView(p: Props) {
  const { rows, quick, tagsOf, paused } = p;
  const [grouping, setGrouping] = useState<TaskGrouping>(() => {
    const v = read(GROUP_KEY, 'fecha');
    return v === 'estado' || v === 'seccion' ? v : 'fecha';
  });
  const [view, setView] = useState(() => read(VIEW_KEY, 'all'));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // El cursor sigue a la tarea aunque cambie de grupo; si desaparece, se queda en su sitio.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const lastAt = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState('');

  const choose = (g: TaskGrouping) => {
    setGrouping(g);
    save(GROUP_KEY, g);
  };
  const go = (v: string) => {
    setView(v);
    save(VIEW_KEY, v);
    lastAt.current = 0;
    setCursorId(null);
  };

  // Nota madre de cada tarea: la ruta («Casa › Cocina») y la de arriba del todo.
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const parent = useMemo(() => parentMap(rows), [rows]);
  const chainOf = useMemo(() => {
    const memo = new Map<string, NoteRow[]>();
    return (r: NoteRow) => {
      if (memo.has(r.id)) return memo.get(r.id)!;
      const up: NoteRow[] = [];
      for (let z = byId.get(parent.get(r.id) ?? ''); z && up.length < 20; z = byId.get(parent.get(z.id) ?? '')) up.unshift(z);
      memo.set(r.id, up);
      return up;
    };
  }, [byId, parent]);
  const sectionOf = (r: NoteRow) => chainOf(r).map((z) => z.title || 'Nota sin título').join(' › ');

  const all = useMemo(() => [...rows.filter((r) => r.kind === 'task'), ...quick], [rows, quick]);
  const active = useMemo(() => all.filter((r) => r.status !== 'done'), [all]);
  const done = useMemo(() => all.filter((r) => r.status === 'done'), [all]);

  // Las listas de la izquierda, con sus cuentas.
  const sections = useMemo(() => {
    const m = new Map<string, { row: NoteRow; n: number }>();
    for (const r of active) {
      const top = chainOf(r)[0];
      if (!top) continue;
      const e = m.get(top.id) ?? { row: top, n: 0 };
      e.n++;
      m.set(top.id, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || titleOf(a.row).localeCompare(titleOf(b.row), 'es'));
  }, [active, chainOf]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of active) for (const t of tagsOf(r)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
  }, [active, tagsOf]);

  const due = (r: NoteRow) => (r.dueAt ? daysUntil(r.dueAt) : null);
  const smart: { id: string; name: string; icon: string; test: (r: NoteRow) => boolean }[] = [
    { id: 'all', name: 'Todas', icon: '◎', test: () => true },
    { id: 'today', name: 'Hoy', icon: '◐', test: (r) => due(r) !== null && due(r)! <= 0 },
    { id: 'week', name: 'Próximos 7 días', icon: '◔', test: (r) => due(r) !== null && due(r)! <= 7 },
    { id: 'quick', name: 'Tareas rápidas', icon: '·', test: (r) => r.kind === 'quick' },
  ];

  const current = useMemo(() => {
    if (view === 'done') return { name: 'Hechas', list: [...done].sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')) };
    if (view.startsWith('sec:')) {
      const id = view.slice(4);
      return { name: byId.get(id) ? titleOf(byId.get(id)!) : 'Nota', list: active.filter((r) => chainOf(r)[0]?.id === id) };
    }
    if (view.startsWith('tag:')) {
      const t = view.slice(4).toLowerCase();
      return { name: `#${view.slice(4)}`, list: active.filter((r) => tagsOf(r).some((x) => x.toLowerCase() === t)) };
    }
    const s = smart.find((x) => x.id === view) ?? smart[0];
    return { name: s.name, list: active.filter(s.test) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, active, done, byId, chainOf, tagsOf]);

  const groups = useMemo(() => {
    if (view === 'done') return current.list.length ? [{ key: 0 as number | string, title: 'Hechas', items: current.list }] : [];
    const out = new Map<string, { key: number | string; title: string; items: NoteRow[] }>();
    for (const r of current.list) {
      let key: number | string;
      let title: string;
      if (grouping === 'estado') [key, title] = r.status === 'doing' ? [0, 'En curso'] : r.status === 'blocked' ? [2, 'Bloqueadas'] : [1, 'Por hacer'];
      else if (grouping === 'fecha') [key, title] = whenGroup(r);
      else if (r.kind === 'quick') [key, title] = ['￾', 'Tareas rápidas'];
      else {
        title = sectionOf(r) || 'Arriba del todo';
        key = sectionOf(r) ? title.toLocaleLowerCase('es') : '￿';
      }
      const g = out.get(title) ?? { key, title, items: [] };
      g.items.push(r);
      out.set(title, g);
    }
    const list = [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const g of list) g.items.sort((a, b) => urgency(b) - urgency(a));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, grouping, view]);

  // Calendario: el mes a la vista, el día elegido (donde se apunta) y la tarea señalada.
  const cal = view === 'cal';
  const [month, setMonth] = useState(() => isoDay(0).slice(0, 7));
  const [calDay, setCalDay] = useState(() => isoDay(0));
  const [calSel, setCalSel] = useState<string | null>(null);
  const pickDay = (iso: string) => {
    setCalDay(iso);
    setMonth(iso.slice(0, 7));
  };
  const shiftDay = (n: number) => {
    const [y, m, d] = calDay.split('-').map(Number);
    pickDay(isoOf(new Date(y, m - 1, d + n)));
  };
  const shiftMonth = (n: number) => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1 + n, 1);
    setMonth(isoOf(first).slice(0, 7));
    setCalDay(isoOf(first));
  };

  const flat = cal ? [] : groups.flatMap((g) => (collapsed.has(g.title) ? [] : g.items));
  const found = flat.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : Math.min(lastAt.current, Math.max(0, flat.length - 1));
  lastAt.current = at;
  const cur = cal ? (all.find((r) => r.id === calSel) ?? null) : (flat[at] ?? null);
  const setCursor = (idx: number) => setCursorId(flat[idx]?.id ?? null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tv-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const toggleDone = (r: NoteRow) => p.onPatch(r.id, r.status === 'done' ? { status: 'todo', doneAt: null } : { status: 'done', doneAt: new Date().toISOString() });

  // Lo que se apunta arriba va a la lista elegida: con su fecha, su etiqueta o dentro de su nota.
  const add = () => {
    const raw = adding.trim();
    if (!raw) return;
    if (view.startsWith('sec:')) p.onAddTask(raw, view.slice(4));
    else if (view.startsWith('tag:')) p.onAddQuick(`${raw} #${view.slice(4)}`);
    else if (view === 'today') p.onAddQuick(raw, { dueAt: isoDay(0) });
    else if (cal) p.onAddQuick(raw, { dueAt: calDay });
    else p.onAddQuick(raw);
    setAdding('');
  };
  const addHint = cal
    ? `Añadir tarea para ${calDay === isoDay(0) ? 'hoy' : dueLabel(calDay)}…`
    : view.startsWith('sec:') ? `Añadir tarea en ${current.name}…` : view === 'today' ? 'Añadir tarea para hoy…' : 'Añadir tarea… (#etiqueta)';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const action = actionFor(e, ['tasks', 'cycleStatus', 'blockTask', 'newNote', 'deleteCell']);
      const k = e.metaKey || e.ctrlKey || e.altKey ? '' : e.key.toLowerCase();
      if (k === 'escape' || action === 'tasks') p.onClose();
      else if (action === 'cycleStatus') cur && p.onCycle(cur.id);
      else if (action === 'blockTask') cur && p.onBlock(cur.id);
      else if (action === 'newNote') addRef.current?.focus();
      else if (action === 'deleteCell' && cur?.kind === 'quick') p.onDeleteQuick(cur.id);
      else if (k === ' ' && cur) toggleDone(cur);
      else if (cal && (k === 'arrowleft' || k === 'h')) shiftDay(-1);
      else if (cal && (k === 'arrowright' || k === 'l')) shiftDay(1);
      else if (cal && (k === 'arrowup' || k === 'k')) shiftDay(-7);
      else if (cal && (k === 'arrowdown' || k === 'j')) shiftDay(7);
      else if (cal && (k === 'pageup' || k === '[')) shiftMonth(-1);
      else if (cal && (k === 'pagedown' || k === ']')) shiftMonth(1);
      else if (cal && k === 't') pickDay(isoDay(0));
      else if (k === 'arrowdown' || k === 'j') setCursor(Math.min(flat.length - 1, at + 1));
      else if (k === 'arrowup' || k === 'k') setCursor(Math.max(0, at - 1));
      else if (k === 'enter' && cur) cur.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(cur.id);
      else if (k === 'tab' && !cal) choose(GROUPINGS[(GROUPINGS.findIndex((g) => g.id === grouping) + (e.shiftKey ? 2 : 1)) % 3].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const Nav = ({ id, name, n, icon }: { id: string; name: string; n?: number; icon?: string }) => (
    <button className={`tv-nav-item${view === id ? ' is-on' : ''}`} aria-current={view === id} onClick={() => go(id)}>
      <span className="tv-nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="tv-nav-name">{name}</span>
      {!!n && <span className="tv-nav-n">{n}</span>}
    </button>
  );

  let i = 0;
  return (
    <div className="tasks-view tv">
      <nav className="tv-side" aria-label="Listas de tareas">
        <button className="sheet-back meta tv-back" onClick={p.onClose}>
          <BackArrow /> {p.back}
        </button>
        {smart.map((s) => (
          <Nav key={s.id} id={s.id} name={s.name} icon={s.icon} n={active.filter(s.test).length} />
        ))}
        {sections.length > 0 && <div className="tv-side-title">Dentro de</div>}
        {sections.map(({ row, n }) => (
          <Nav key={row.id} id={`sec:${row.id}`} name={titleOf(row)} icon="◇" n={n} />
        ))}
        {tags.length > 0 && <div className="tv-side-title">Etiquetas</div>}
        {tags.map(([t, n]) => (
          <Nav key={t} id={`tag:${t}`} name={t} icon="#" n={n} />
        ))}
        <div className="tv-side-sep" />
        <Nav id="cal" name="Calendario" icon="▦" />
        <Nav id="done" name="Hechas" icon="✓" n={done.length} />
      </nav>

      <main className="tv-main">
        <header className="tv-head">
          <h1 className="tv-title">
            {cal ? cap(MONTH.format(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1))) : current.name}{' '}
            {!cal && <span className="tv-count">{current.list.length}</span>}
          </h1>
          {cal && (
            <div className="tv-group-by" aria-label="Mes">
              <button onClick={() => shiftMonth(-1)} aria-label="Mes anterior">
                ‹
              </button>
              <button onClick={() => pickDay(isoDay(0))}>Hoy</button>
              <button onClick={() => shiftMonth(1)} aria-label="Mes siguiente">
                ›
              </button>
            </div>
          )}
          {view !== 'done' && !cal && (
            <div className="tv-group-by" role="radiogroup" aria-label="Agrupar por">
              {GROUPINGS.map((g) => (
                <button key={g.id} role="radio" aria-checked={g.id === grouping} className={g.id === grouping ? 'is-on' : ''} onClick={() => choose(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
          )}
        </header>
        {view !== 'done' && (
          <div className="tv-add">
            <span className="tv-add-plus" aria-hidden="true">
              +
            </span>
            <input
              ref={addRef}
              placeholder={addHint}
              aria-label="Añadir tarea"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
                else if (e.key === 'Escape') e.currentTarget.blur();
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            />
            <span className="tv-add-key">N</span>
          </div>
        )}
        {cal && (
          <TaskCalendar
            month={month}
            day={calDay}
            tasks={all}
            selected={calSel}
            onDay={pickDay}
            onSelect={(r) => {
              setCalSel(r.id);
              if (r.dueAt) setCalDay(r.dueAt.slice(0, 10));
            }}
            onOpen={(r) => (r.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(r.id))}
            onToggle={toggleDone}
            onMove={(id, iso) => p.onPatch(id, { dueAt: iso })}
          />
        )}
        <div className="tv-list" ref={listRef} hidden={cal}>
          {!groups.length && <p className="tv-empty">{view === 'done' ? 'Aún no hay nada hecho.' : 'Nada pendiente aquí.'}</p>}
          {groups.map((g) => {
            const shut = collapsed.has(g.title);
            return (
              <section key={g.title} className={`tv-group${g.key === 0 && grouping === 'fecha' && view !== 'done' ? ' is-late' : ''}`}>
                <button
                  className="tv-group-title"
                  aria-expanded={!shut}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(g.title)) n.delete(g.title);
                      else n.add(g.title);
                      return n;
                    })
                  }
                >
                  <span className={`tv-caret${shut ? ' is-shut' : ''}`} aria-hidden="true">
                    ▾
                  </span>
                  {g.title} <span className="tv-count">{g.items.length}</span>
                </button>
                {!shut &&
                  g.items.map((r) => {
                    const idx = i++;
                    const d = due(r);
                    const where = r.kind === 'quick' ? '' : grouping === 'seccion' ? '' : chainOf(r).at(-1)?.title ?? '';
                    return (
                      <div
                        key={r.id}
                        className={`tv-row${idx === at ? ' is-cursor' : ''}${r.status === 'done' ? ' is-done' : ''}`}
                        onMouseDown={() => setCursor(idx)}
                        // Sin sitio para el detalle (pantallas estrechas), un toque abre la nota.
                        onClick={() => r.kind !== 'quick' && window.innerWidth <= 1100 && p.onOpen(r.id)}
                        onDoubleClick={() => (r.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(r.id))}
                      >
                        <Check row={r} onToggle={() => toggleDone(r)} />
                        <span className="tv-row-title">{titleOf(r)}</span>
                        {tagsOf(r).map((t) => (
                          <span key={t} className="tv-tag">
                            #{t}
                          </span>
                        ))}
                        {where && <span className="tv-where">{where}</span>}
                        {r.dueAt && <span className={`tv-due${d! < 0 && r.status !== 'done' ? ' is-late' : d === 0 ? ' is-today' : ''}`}>{dueLabel(r.dueAt)}</span>}
                      </div>
                    );
                  })}
              </section>
            );
          })}
        </div>
        <p className="tv-foot meta">
          {cal
            ? '←→↑↓ día · [ ] mes · T hoy · arrastra una tarea para cambiar su fecha · N añadir en el día · Esc salir'
            : '↑↓ moverse · Espacio hecha · X estado · Enter abrir · N añadir · Tab agrupar · Esc salir'}
        </p>
      </main>

      <Detail key={cur?.id ?? 'none'} row={cur} p={p} section={cur ? sectionOf(cur) : ''} titleRef={titleRef} onToggle={() => cur && toggleDone(cur)} />
    </div>
  );
}

// La casilla: vacía, con punto (en curso), con raya (bloqueada) o marcada.
function Check({ row, onToggle }: { row: NoteRow; onToggle: () => void }) {
  const s = row.status ?? 'todo';
  return (
    <button
      className={`tv-check is-${s} prio-${row.priority ?? 0}`}
      role="checkbox"
      aria-checked={s === 'done'}
      aria-label={s === 'done' ? 'Marcar pendiente' : 'Marcar hecha'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {s === 'done' && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.2 5 8.5l4.5-5" />
        </svg>
      )}
    </button>
  );
}

function Detail({
  row,
  p,
  section,
  titleRef,
  onToggle,
}: {
  row: NoteRow | null;
  p: Props;
  section: string;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onToggle: () => void;
}) {
  const [title, setTitle] = useState(row?.title ?? '');
  const [tag, setTag] = useState('');
  if (!row) return <aside className="tv-detail tv-detail-empty">Elige una tarea para ver su detalle.</aside>;
  const quick = row.kind === 'quick';
  const tags = p.tagsOf(row);
  const body = (row.bodyText ?? '').split('\n').slice(row.title ? 1 : 0).join('\n').trim();

  const saveTitle = () => {
    const t = title.trim();
    if (!t || t === row.title) return setTitle(row.title ?? '');
    if (quick) p.onEditQuick(row.id, t);
    else {
      const { text, tags: more } = splitTags(t);
      if (text && text !== row.title) p.onRename(row.id, text);
      if (more.length) p.onSetTags(row, mergeTags(tags, more));
      setTitle(text || row.title || '');
    }
  };

  return (
    <aside className="tv-detail" aria-label="Detalle de la tarea">
      <div className="tv-detail-bar">
        <Check row={row} onToggle={onToggle} />
        <input
          type="date"
          className={`tv-date${row.dueAt && daysUntil(row.dueAt) < 0 && row.status !== 'done' ? ' is-late' : ''}`}
          aria-label="Fecha"
          value={row.dueAt?.slice(0, 10) ?? ''}
          onChange={(e) => p.onPatch(row.id, { dueAt: e.target.value || null })}
        />
        <div className="tv-prio" role="radiogroup" aria-label="Prioridad">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={row.priority === n}
              title={PRIOS[n]}
              className={`prio-${n}${row.priority === n ? ' is-on' : ''}`}
              onClick={() => p.onPatch(row.id, { priority: row.priority === n ? 0 : n })}
            >
              {'!'.repeat(n)}
            </button>
          ))}
        </div>
      </div>

      <input
        ref={titleRef}
        className="tv-detail-title"
        aria-label="Título"
        value={title}
        placeholder="Tarea sin título"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setTitle(row.title ?? '');
            e.currentTarget.blur();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <p className="tv-detail-where">{quick ? 'Tarea rápida · solo vive en esta vista' : section ? `Dentro de ${section}` : 'Arriba del todo'}</p>

      <div className="tv-status" role="radiogroup" aria-label="Estado">
        {STATUSES.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={(row.status ?? 'todo') === s.id}
            className={(row.status ?? 'todo') === s.id ? 'is-on' : ''}
            onClick={() => p.onPatch(row.id, { status: s.id, doneAt: s.id === 'done' ? new Date().toISOString() : null })}
          >
            {s.name}
          </button>
        ))}
      </div>

      <div className="tv-detail-tags">
        {tags.map((t) => (
          <button key={t} className="tv-tag is-chip" title="Quitar" onClick={() => p.onSetTags(row, tags.filter((x) => x !== t))}>
            #{t} <span aria-hidden="true">×</span>
          </button>
        ))}
        <input
          className="tv-tag-add"
          placeholder="+ etiqueta"
          aria-label="Añadir etiqueta"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            const t = tag.replace(/^#/, '').trim();
            if ((e.key === 'Enter' || e.key === ',') && t) {
              e.preventDefault();
              p.onSetTags(row, mergeTags(tags, [t]));
              setTag('');
            }
            e.stopPropagation();
          }}
        />
      </div>

      {!quick && body && <p className="tv-detail-body">{body.length > 600 ? `${body.slice(0, 600)}…` : body}</p>}

      <div className="tv-detail-foot">
        {quick ? (
          <button className="set-button tv-danger" onClick={() => p.onDeleteQuick(row.id)}>
            Borrar
          </button>
        ) : (
          <button className="set-button" onClick={() => p.onOpen(row.id)}>
            Abrir nota
          </button>
        )}
      </div>
    </aside>
  );
}

// Mes en cuadrícula, de lunes a domingo. Las tareas con fecha van en su día;
// se arrastran a otro para cambiarla, y el día elegido es donde se apunta.
function TaskCalendar({
  month,
  day,
  tasks,
  selected,
  onDay,
  onSelect,
  onOpen,
  onToggle,
  onMove,
}: {
  month: string;
  day: string;
  tasks: NoteRow[];
  selected: string | null;
  onDay: (iso: string) => void;
  onSelect: (r: NoteRow) => void;
  onOpen: (r: NoteRow) => void;
  onToggle: (r: NoteRow) => void;
  onMove: (id: string, iso: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const today = isoDay(0);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;

  const byDay = useMemo(() => {
    const out = new Map<string, NoteRow[]>();
    for (const r of tasks) {
      if (!r.dueAt) continue;
      const k = r.dueAt.slice(0, 10);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    for (const list of out.values()) list.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || urgency(b) - urgency(a));
    return out;
  }, [tasks]);

  return (
    <div className="tv-cal" style={{ '--weeks': weeks } as React.CSSProperties}>
      {DOW.map((d) => (
        <div key={d} className="tv-cal-dow">
          {d}
        </div>
      ))}
      {days.slice(0, weeks * 7).map((iso) => {
        const list = byDay.get(iso) ?? [];
        const shown = list.slice(0, 4);
        return (
          <div
            key={iso}
            className={`tv-cal-day${iso.slice(0, 7) !== month ? ' is-other' : ''}${iso === today ? ' is-today' : ''}${iso === day ? ' is-on' : ''}${over === iso ? ' is-over' : ''}`}
            onClick={() => onDay(iso)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(iso);
            }}
            onDragLeave={() => setOver((o) => (o === iso ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/canvian-task');
              if (id) onMove(id, iso);
            }}
          >
            <span className="tv-cal-num">{Number(iso.slice(8))}</span>
            {shown.map((r) => (
              <div
                key={r.id}
                className={`tv-cal-task${r.status === 'done' ? ' is-done' : ''}${r.id === selected ? ' is-sel' : ''}${r.status !== 'done' && iso < today ? ' is-late' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/canvian-task', r.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(r);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onOpen(r);
                }}
              >
                <Check row={r} onToggle={() => onToggle(r)} />
                <span>{titleOf(r)}</span>
              </div>
            ))}
            {list.length > shown.length && <span className="tv-cal-more">+{list.length - shown.length} más</span>}
          </div>
        );
      })}
    </div>
  );
}
