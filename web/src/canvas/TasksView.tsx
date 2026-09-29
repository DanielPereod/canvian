import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { parentMap } from './sections';
import type { NoteInput, NoteRow, TaskStatus } from '../api';
import { daysUntil, dueLabel, localToday } from './dates';
import { actionFor, keysBlocked } from '../keys';
import { mergeTags, splitTags } from './tags';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { Resizer, useSideWidth } from './Resizer';

// Vista de tareas, fuera del mapa, en tres columnas: a la izquierda las
// listas (Hoy, 7 días, rápidas, por nota madre y por etiqueta), en el centro
// las tareas de la elegida (en lista o en tablero por estado) y a la derecha
// el detalle de la señalada.
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
const LAYOUT_KEY = 'canvian.tasksLayout';
const CAL_KEY = 'canvian.calMode';
const DONE_SHOWN = 20;

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
const noteTitle = (r: NoteRow) => r.title || 'Nota sin título';
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MONTH = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const DOW = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const LONG_DAY = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const SHORT_DOW = new Intl.DateTimeFormat('es-ES', { weekday: 'short' });
const RANGE = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso: string, n: number) => {
  const d = dateOf(iso);
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
const mondayOf = (iso: string) => addDays(iso, -((dateOf(iso).getDay() + 6) % 7));

// Formas de ver el calendario. Las fechas son de día, sin hora: cada vista
// enseña más o menos días y cuánto sitio tiene cada uno.
export type CalMode = 'agenda' | 'dia' | 'tres' | 'semana' | 'mes';
const CAL_MODES: { id: CalMode; label: string }[] = [
  { id: 'agenda', label: 'Agenda' },
  { id: 'dia', label: 'Día' },
  { id: 'tres', label: '3 días' },
  { id: 'semana', label: 'Semana' },
  { id: 'mes', label: 'Mes' },
];

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
  /** Notas que pueden ser madre de una tarea, con su ruta. */
  sections: SectionOption[];
  onMoveTask: (id: string, zoneId: string | null) => void;
  onEditQuick: (id: string, title: string) => void;
  onDeleteQuick: (id: string) => void;
  tagsOf: (r: NoteRow) => string[];
  onSetTags: (r: NoteRow, tags: string[]) => void;
  onClose: () => void;
  paused: boolean;
};

export function TasksView(p: Props) {
  const { rows, quick, tagsOf, paused } = p;
  const sideWidth = useSideWidth('canvian.tasksSideWidth', 232, 180, 400);
  const detailWidth = useSideWidth('canvian.tasksDetailWidth', 360, 280, 640);
  const [grouping, setGrouping] = useState<TaskGrouping>(() => {
    const v = read(GROUP_KEY, 'fecha');
    return v === 'estado' || v === 'seccion' ? v : 'fecha';
  });
  const [view, setView] = useState(() => read(VIEW_KEY, 'all'));
  const [layout, setLayout] = useState<'lista' | 'tablero'>(() => (read(LAYOUT_KEY, 'lista') === 'tablero' ? 'tablero' : 'lista'));
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // El cursor sigue a la tarea aunque cambie de grupo; si desaparece, se queda en su sitio.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const lastAt = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState('');
  const [moving, setMoving] = useState<string | null>(null);

  const choose = (g: TaskGrouping) => {
    setGrouping(g);
    save(GROUP_KEY, g);
  };
  const pickLayout = (l: 'lista' | 'tablero') => {
    setLayout(l);
    save(LAYOUT_KEY, l);
  };
  const go = (v: string) => {
    setView(v);
    save(VIEW_KEY, v);
    lastAt.current = 0;
    setCursorId(null);
  };

  // Nota madre de cada tarea: la ruta entera («Casa › Cocina») y la madre directa («Cocina»),
  // que es la que se enseña; la ruta queda para el título al pasar el ratón.
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
  const pathOf = (id: string) => chainOf(byId.get(id)!).concat(byId.get(id)!).map(noteTitle).join(' › ');
  const homeOf = (r: NoteRow) => chainOf(r).at(-1);

  const all = useMemo(() => [...rows.filter((r) => r.kind === 'task'), ...quick], [rows, quick]);
  const active = useMemo(() => all.filter((r) => r.status !== 'done'), [all]);
  const done = useMemo(() => all.filter((r) => r.status === 'done'), [all]);

  // Las listas de la izquierda, con sus cuentas.
  const sections = useMemo(() => {
    const m = new Map<string, { row: NoteRow; n: number }>();
    for (const r of active) {
      const home = homeOf(r);
      if (!home) continue;
      const e = m.get(home.id) ?? { row: home, n: 0 };
      e.n++;
      m.set(home.id, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || noteTitle(a.row).localeCompare(noteTitle(b.row), 'es'));
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
    if (view === 'done') return { name: 'Hechas', list: [...done].sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')), test: () => true };
    let name: string;
    let test: (r: NoteRow) => boolean;
    if (view.startsWith('sec:')) {
      const id = view.slice(4);
      name = byId.get(id) ? noteTitle(byId.get(id)!) : 'Nota';
      test = (r) => homeOf(r)?.id === id;
    } else if (view.startsWith('tag:')) {
      const t = view.slice(4).toLowerCase();
      name = `#${view.slice(4)}`;
      test = (r) => tagsOf(r).some((x) => x.toLowerCase() === t);
    } else {
      const s = smart.find((x) => x.id === view) ?? smart[0];
      name = s.name;
      test = s.test;
    }
    return { name, list: active.filter(test), test };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, active, done, byId, chainOf, tagsOf]);

  const groups = useMemo(() => {
    if (view === 'done') return current.list.length ? [{ key: 0 as number | string, title: 'Hechas', items: current.list }] : [];
    const out = new Map<string, { key: number | string; title: string; items: NoteRow[] }>();
    for (const r of current.list) {
      let key: number | string;
      let title: string;
      // Dos madres con el mismo nombre en sitios distintos son dos grupos.
      let at: string | undefined;
      if (grouping === 'estado') [key, title] = r.status === 'doing' ? [0, 'En curso'] : r.status === 'blocked' ? [2, 'Bloqueadas'] : [1, 'Por hacer'];
      else if (grouping === 'fecha') [key, title] = whenGroup(r);
      else if (r.kind === 'quick') [key, title] = ['￾', 'Tareas rápidas'];
      else {
        const home = homeOf(r);
        at = home?.id;
        title = home ? noteTitle(home) : 'Arriba del todo';
        key = home ? `${title.toLocaleLowerCase('es')}\u0000${home.id}` : '￿';
      }
      const g = out.get(at ?? title) ?? { key, title, items: [] };
      g.items.push(r);
      out.set(at ?? title, g);
    }
    const list = [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const g of list) g.items.sort((a, b) => urgency(b) - urgency(a));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, grouping, view]);

  // Calendario: la vista (agenda, día, 3 días, semana o mes), el mes a la vista,
  // el día elegido (donde se apunta) y la tarea señalada.
  const cal = view === 'cal';
  const [calMode, setCalMode] = useState<CalMode>(() => {
    const v = read(CAL_KEY, 'mes');
    return CAL_MODES.some((m) => m.id === v) ? (v as CalMode) : 'mes';
  });
  const [month, setMonth] = useState(() => isoDay(0).slice(0, 7));
  const [calDay, setCalDay] = useState(() => isoDay(0));
  // En «3 días», el primero de los tres: no se mueve mientras el día elegido siga dentro.
  const [threeFrom, setThreeFrom] = useState(() => isoDay(0));
  const [calSel, setCalSel] = useState<string | null>(null);
  const pickMode = (m: CalMode) => {
    setCalMode(m);
    save(CAL_KEY, m);
    if (m === 'tres') setThreeFrom(calDay);
  };
  const pickDay = (iso: string) => {
    setCalDay(iso);
    setMonth(iso.slice(0, 7));
    setThreeFrom((f) => (iso < f ? iso : iso > addDays(f, 2) ? addDays(iso, -2) : f));
  };
  const goToday = () => {
    pickDay(isoDay(0));
    setThreeFrom(isoDay(0));
  };
  const shiftDay = (n: number) => pickDay(addDays(calDay, n));
  const shiftMonth = (n: number) => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1 + n, 1);
    setMonth(isoOf(first).slice(0, 7));
    setCalDay(isoOf(first));
  };
  // ‹ › y [ ]: un periodo entero de la vista.
  const shiftPeriod = (n: number) => {
    if (calMode === 'mes') return shiftMonth(n);
    if (calMode === 'tres') {
      setThreeFrom((f) => addDays(f, 3 * n));
      setCalDay((d) => addDays(d, 3 * n));
      setMonth(addDays(calDay, 3 * n).slice(0, 7));
      return;
    }
    shiftDay(calMode === 'dia' ? n : 7 * n);
  };
  const calDays = calMode === 'dia' ? [calDay] : calMode === 'tres' ? [0, 1, 2].map((k) => addDays(threeFrom, k)) : Array.from({ length: 7 }, (_, k) => addDays(mondayOf(calDay), k));
  const calTitle =
    calMode === 'mes'
      ? cap(MONTH.format(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)))
      : calMode === 'dia'
        ? cap(LONG_DAY.format(dateOf(calDay)))
        : calMode === 'agenda'
          ? calDay === isoDay(0)
            ? 'Agenda'
            : `Agenda desde el ${LONG_DAY.format(dateOf(calDay))}`
          : RANGE.formatRange(dateOf(calDays[0]), dateOf(calDays[calDays.length - 1]));
  const PERIOD: Record<CalMode, [string, string]> = {
    agenda: ['Semana anterior', 'Semana siguiente'],
    dia: ['Día anterior', 'Día siguiente'],
    tres: ['3 días antes', '3 días después'],
    semana: ['Semana anterior', 'Semana siguiente'],
    mes: ['Mes anterior', 'Mes siguiente'],
  };

  // Tablero: una columna por estado. Las hechas, solo las últimas.
  const board = layout === 'tablero' && view !== 'done' && !cal;
  const columns = useMemo(() => {
    if (!board) return [];
    return STATUSES.map((s) => {
      const mine = s.id === 'done' ? done.filter(current.test).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')) : current.list.filter((r) => (r.status ?? 'todo') === s.id).sort((a, b) => urgency(b) - urgency(a));
      return { ...s, items: mine.slice(0, s.id === 'done' ? DONE_SHOWN : undefined), total: mine.length };
    });
  }, [board, current, done]);
  const colOf = (id: string | null) => columns.findIndex((c) => c.items.some((r) => r.id === id));
  const firstCard = columns.find((c) => c.items.length)?.items[0] ?? null;
  const boardCur = colOf(cursorId) >= 0 ? cursorId : (firstCard?.id ?? null);
  const moveTo = (r: NoteRow, s: TaskStatus) => {
    if ((r.status ?? 'todo') === s) return;
    p.onPatch(r.id, { status: s, doneAt: s === 'done' ? new Date().toISOString() : null });
  };
  // Con las flechas por el tablero: ←→ de columna (a la misma altura), ↑↓ dentro de ella.
  const boardStep = (dc: number, dr: number) => {
    const c = colOf(boardCur);
    if (c < 0) return;
    const r = columns[c].items.findIndex((x) => x.id === boardCur);
    if (dr) return setCursorId(columns[c].items[Math.max(0, Math.min(columns[c].items.length - 1, r + dr))]?.id ?? null);
    for (let n = c + dc; n >= 0 && n < columns.length; n += dc) {
      const list = columns[n].items;
      if (list.length) return setCursorId(list[Math.min(r, list.length - 1)].id);
    }
  };

  const flat = cal || board ? [] : groups.flatMap((g) => (collapsed.has(g.title) ? [] : g.items));
  const found = flat.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : Math.min(lastAt.current, Math.max(0, flat.length - 1));
  lastAt.current = at;
  const cur = cal ? (all.find((r) => r.id === calSel) ?? null) : board ? (all.find((r) => r.id === boardCur) ?? null) : (flat[at] ?? null);
  const setCursor = (idx: number) => setCursorId(flat[idx]?.id ?? null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tv-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  useEffect(() => {
    if (board) document.querySelector<HTMLElement>('.tv-card.is-cursor')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [board, boardCur]);

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
      if (paused || moving || keysBlocked()) return;
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
      else if (k === 'm' && cur) setMoving(cur.id);
      else if (k === 'v' && view !== 'done' && !cal) pickLayout(board ? 'lista' : 'tablero');
      else if (board && e.shiftKey && (k === 'arrowleft' || k === 'arrowright' || k === 'h' || k === 'l') && cur) {
        const n = STATUSES.findIndex((s) => s.id === (cur.status ?? 'todo')) + (k === 'arrowleft' || k === 'h' ? -1 : 1);
        if (STATUSES[n]) moveTo(cur, STATUSES[n].id);
      } else if (board && (k === 'arrowleft' || k === 'h')) boardStep(-1, 0);
      else if (board && (k === 'arrowright' || k === 'l')) boardStep(1, 0);
      else if (board && (k === 'arrowup' || k === 'k')) boardStep(0, -1);
      else if (board && (k === 'arrowdown' || k === 'j')) boardStep(0, 1);
      else if (cal && /^[1-5]$/.test(k)) pickMode(CAL_MODES[Number(k) - 1].id);
      else if (cal && (k === 'arrowleft' || k === 'h')) shiftDay(-1);
      else if (cal && (k === 'arrowright' || k === 'l')) shiftDay(1);
      else if (cal && (k === 'arrowup' || k === 'k')) shiftDay(calMode === 'mes' || calMode === 'semana' ? -7 : -1);
      else if (cal && (k === 'arrowdown' || k === 'j')) shiftDay(calMode === 'mes' || calMode === 'semana' ? 7 : 1);
      else if (cal && (k === 'pageup' || k === '[')) shiftPeriod(-1);
      else if (cal && (k === 'pagedown' || k === ']')) shiftPeriod(1);
      else if (cal && k === 't') goToday();
      else if (k === 'arrowdown' || k === 'j') setCursor(Math.min(flat.length - 1, at + 1));
      else if (k === 'arrowup' || k === 'k') setCursor(Math.max(0, at - 1));
      else if (k === 'enter' && cur) cur.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(cur.id);
      else if (k === 'tab' && !cal && !board) choose(GROUPINGS[(GROUPINGS.findIndex((g) => g.id === grouping) + (e.shiftKey ? 2 : 1)) % 3].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const Nav = ({ id, name, n, icon, hint }: { id: string; name: string; n?: number; icon?: string; hint?: string }) => (
    <button className={`tv-nav-item${view === id ? ' is-on' : ''}`} aria-current={view === id} onClick={() => go(id)} title={hint}>
      <span className="tv-nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="tv-nav-name">{name}</span>
      {!!n && <span className="tv-nav-n">{n}</span>}
    </button>
  );

  let i = 0;
  return (
    <div className="tasks-view tv" style={{ '--tv-side-w': `${sideWidth.width}px`, '--tv-detail-w': `${detailWidth.width}px` } as CSSProperties}>
      <nav className="tv-side" aria-label="Listas de tareas">
        {smart.map((s) => (
          <Nav key={s.id} id={s.id} name={s.name} icon={s.icon} n={active.filter(s.test).length} />
        ))}
        {sections.length > 0 && <div className="tv-side-title">Dentro de</div>}
        {sections.map(({ row, n }) => (
          <Nav key={row.id} id={`sec:${row.id}`} name={noteTitle(row)} hint={pathOf(row.id)} icon="◇" n={n} />
        ))}
        {tags.length > 0 && <div className="tv-side-title">Etiquetas</div>}
        {tags.map(([t, n]) => (
          <Nav key={t} id={`tag:${t}`} name={t} icon="#" n={n} />
        ))}
        <div className="tv-side-sep" />
        <Nav id="cal" name="Calendario" icon="▦" />
        <Nav id="done" name="Hechas" icon="✓" n={done.length} />
      </nav>

      <Resizer size={sideWidth} edge="right" className="tv-side-resizer" />

      <main className="tv-main">
        <header className="tv-head">
          <h1 className="tv-title">
            {cal ? calTitle : current.name}{' '}
            {!cal && <span className="tv-count">{current.list.length}</span>}
          </h1>
          {cal && (
            <div className="tv-head-tools">
              <div className="tv-group-by" role="radiogroup" aria-label="Vista del calendario">
                {CAL_MODES.map((m, n) => (
                  <button key={m.id} role="radio" aria-checked={calMode === m.id} className={calMode === m.id ? 'is-on' : ''} onClick={() => pickMode(m.id)} title={`${m.label} (${n + 1})`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="tv-group-by" aria-label="Moverse">
                <button onClick={() => shiftPeriod(-1)} aria-label={PERIOD[calMode][0]} title={`${PERIOD[calMode][0]} ([)`}>
                  ‹
                </button>
                <button onClick={goToday} title="Hoy (T)">
                  Hoy
                </button>
                <button onClick={() => shiftPeriod(1)} aria-label={PERIOD[calMode][1]} title={`${PERIOD[calMode][1]} (])`}>
                  ›
                </button>
              </div>
            </div>
          )}
          {view !== 'done' && !cal && (
            <div className="tv-head-tools">
              {!board && (
                <div className="tv-group-by" role="radiogroup" aria-label="Agrupar por">
                  {GROUPINGS.map((g) => (
                    <button key={g.id} role="radio" aria-checked={g.id === grouping} className={g.id === grouping ? 'is-on' : ''} onClick={() => choose(g.id)}>
                      {g.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="tv-group-by" role="radiogroup" aria-label="Forma">
                {(['lista', 'tablero'] as const).map((l) => (
                  <button key={l} role="radio" aria-checked={layout === l} className={layout === l ? 'is-on' : ''} onClick={() => pickLayout(l)}>
                    {l === 'lista' ? 'Lista' : 'Tablero'}
                  </button>
                ))}
              </div>
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
            mode={calMode}
            month={month}
            days={calDays}
            day={calDay}
            tasks={all}
            selected={calSel}
            whereOf={(r) => (r.kind === 'quick' ? '' : homeOf(r) ? noteTitle(homeOf(r)!) : '')}
            onDay={pickDay}
            onSelect={(r) => {
              setCalSel(r.id);
              // En la agenda, el día elegido es desde dónde empieza: señalar no la mueve.
              if (r.dueAt && calMode !== 'agenda') (calMode === 'mes' ? setCalDay : pickDay)(r.dueAt.slice(0, 10));
            }}
            onOpen={(r) => (r.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(r.id))}
            onToggle={toggleDone}
            onMove={(id, iso) => p.onPatch(id, { dueAt: iso })}
          />
        )}
        {board && (
          <div className="tv-board">
            {columns.map((c) => (
              <section
                key={c.id}
                className={`tv-col tv-col-${c.id}${over === c.id ? ' is-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(c.id);
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  const r = all.find((x) => x.id === e.dataTransfer.getData('text/plain'));
                  if (r) moveTo(r, c.id);
                }}
              >
                <h2 className="tv-col-title">
                  {c.name} <span className="tv-count">{c.total}</span>
                </h2>
                <div className="tv-col-list">
                  {c.items.map((r) => {
                    const d = due(r);
                    const where = r.kind === 'quick' ? '' : (chainOf(r).at(-1)?.title ?? '');
                    const t = tagsOf(r);
                    return (
                      <div
                        key={r.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', r.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        className={`tv-card${r.id === boardCur ? ' is-cursor' : ''}${r.status === 'done' ? ' is-done' : ''}`}
                        onMouseDown={() => setCursorId(r.id)}
                        onClick={() => r.kind !== 'quick' && window.innerWidth <= 1100 && p.onOpen(r.id)}
                        onDoubleClick={() => (r.kind === 'quick' ? titleRef.current?.focus() : p.onOpen(r.id))}
                      >
                        <div className="tv-card-top">
                          <Check row={r} onToggle={() => toggleDone(r)} />
                          <span className="tv-card-title">{titleOf(r)}</span>
                        </div>
                        {(where || r.dueAt || t.length > 0) && (
                          <div className="tv-card-meta">
                            {r.dueAt && <span className={`tv-due${d! < 0 && r.status !== 'done' ? ' is-late' : d === 0 ? ' is-today' : ''}`}>{dueLabel(r.dueAt)}</span>}
                            {t.map((x) => (
                              <span key={x} className="tv-tag">
                                #{x}
                              </span>
                            ))}
                            {where && <span className="tv-where">{where}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!c.items.length && <p className="tv-col-empty">{over === c.id ? 'Suelta aquí' : 'Nada'}</p>}
                  {c.total > c.items.length && <p className="tv-col-empty">y {c.total - c.items.length} más en Hechas</p>}
                </div>
              </section>
            ))}
          </div>
        )}
        <div className="tv-list" ref={listRef} hidden={cal || board}>
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
            ? `1–5 vista · ←→${calMode === 'mes' || calMode === 'semana' ? '↑↓' : ''} día · [ ] ${calMode === 'mes' ? 'mes' : calMode === 'dia' ? 'día' : calMode === 'tres' ? '3 días' : 'semana'} · T hoy · arrastra una tarea para cambiar su fecha · N añadir en el día · Esc salir`
            : board
              ? '←→↑↓ moverse · Mayús ←→ cambiar de columna · arrastra una tarjeta · Espacio hecha · M nota madre · V lista · Esc salir'
              : '↑↓ moverse · Espacio hecha · X estado · M nota madre · N añadir · Tab agrupar · V tablero · Esc salir'}
        </p>
      </main>

      <Resizer size={detailWidth} edge="left" className="tv-resizer" />
      <Detail key={cur?.id ?? 'none'} row={cur} p={p} section={cur && homeOf(cur) ? noteTitle(homeOf(cur)!) : ''} path={cur && homeOf(cur) ? pathOf(homeOf(cur)!.id) : ''} titleRef={titleRef} onToggle={() => cur && toggleDone(cur)} onMove={() => cur && setMoving(cur.id)} />
      {moving && (
        <SectionPicker
          // Una rápida no tiene «Arriba del todo»: sin madre ya es rápida.
          options={all.find((r) => r.id === moving)?.kind === 'quick' ? p.sections.filter((o) => o.id) : p.sections}
          current={all.find((r) => r.id === moving)?.zoneId ?? null}
          exclude={new Set([moving])}
          onPick={(zoneId) => {
            p.onMoveTask(moving, zoneId);
            setMoving(null);
          }}
          onClose={() => setMoving(null)}
        />
      )}
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
  path,
  titleRef,
  onToggle,
  onMove,
}: {
  row: NoteRow | null;
  p: Props;
  // La madre directa y, para el título al pasar el ratón, su ruta entera.
  section: string;
  path: string;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onToggle: () => void;
  onMove: () => void;
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
      <button className="tv-detail-where" onClick={onMove} title={path ? `${path} · cambiar la nota madre (M)` : 'Cambiar la nota madre (M)'}>
        {quick ? 'Tarea rápida · solo vive en esta vista' : section ? `Dentro de ${section}` : 'Arriba del todo'}
        <span className="tv-detail-move">{quick ? 'Meter en una nota' : 'Cambiar'}</span>
      </button>

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
          <button className="set-button tv-expand" onClick={() => p.onOpen(row.id)} title="Ver en grande (Enter)" aria-label="Ver en grande">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />
            </svg>
          </button>
        )}
      </div>
    </aside>
  );
}

// Las tareas con fecha, por día; en cada uno, primero las pendientes y lo que más urge.
function useByDay(tasks: NoteRow[]) {
  return useMemo(() => {
    const out = new Map<string, NoteRow[]>();
    for (const r of tasks) {
      if (!r.dueAt) continue;
      const k = r.dueAt.slice(0, 10);
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    for (const list of out.values()) list.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || urgency(b) - urgency(a));
    return out;
  }, [tasks]);
}

type CalProps = {
  mode: CalMode;
  month: string;
  // Los días a la vista en «Día», «3 días» y «Semana».
  days: string[];
  day: string;
  tasks: NoteRow[];
  selected: string | null;
  whereOf: (r: NoteRow) => string;
  onDay: (iso: string) => void;
  onSelect: (r: NoteRow) => void;
  onOpen: (r: NoteRow) => void;
  onToggle: (r: NoteRow) => void;
  onMove: (id: string, iso: string) => void;
};

// Un sitio donde soltar una tarea para darle ese día.
function dropOn(iso: string, setOver: (f: (o: string | null) => string | null) => void, onMove: CalProps['onMove']) {
  return {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(() => iso);
    },
    onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver((o) => (o === iso ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(() => null);
      const id = e.dataTransfer.getData('text/canvian-task');
      if (id) onMove(id, iso);
    },
  };
}

// Una tarea en el calendario: se señala con un clic, se abre con doble clic y se arrastra a otro día.
function CalTask({ r, iso, p, where }: { r: NoteRow; iso: string; p: CalProps; where?: string }) {
  const today = isoDay(0);
  return (
    <div
      className={`tv-cal-task${r.status === 'done' ? ' is-done' : ''}${r.id === p.selected ? ' is-sel' : ''}${r.status !== 'done' && iso < today ? ' is-late' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/canvian-task', r.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        e.stopPropagation();
        p.onSelect(r);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        p.onOpen(r);
      }}
    >
      <Check row={r} onToggle={() => p.onToggle(r)} />
      <span>{titleOf(r)}</span>
      {where && <em className="tv-cal-where">{where}</em>}
    </div>
  );
}

function TaskCalendar(p: CalProps) {
  if (p.mode === 'agenda') return <CalAgenda {...p} />;
  if (p.mode === 'mes') return <CalMonth {...p} />;
  return <CalColumns {...p} />;
}

// Mes en cuadrícula, de lunes a domingo. Las tareas con fecha van en su día;
// se arrastran a otro para cambiarla, y el día elegido es donde se apunta.
function CalMonth(p: CalProps) {
  const { month, day } = p;
  const [over, setOver] = useState<string | null>(null);
  const today = isoDay(0);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;
  const byDay = useByDay(p.tasks);

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
            onClick={() => p.onDay(iso)}
            {...dropOn(iso, setOver, p.onMove)}
          >
            <span className="tv-cal-num">{Number(iso.slice(8))}</span>
            {shown.map((r) => (
              <CalTask key={r.id} r={r} iso={iso} p={p} />
            ))}
            {list.length > shown.length && <span className="tv-cal-more">+{list.length - shown.length} más</span>}
          </div>
        );
      })}
    </div>
  );
}

// Día, 3 días y semana: una columna por día, con todas sus tareas (se desplaza si no caben).
function CalColumns(p: CalProps) {
  const [over, setOver] = useState<string | null>(null);
  const today = isoDay(0);
  const byDay = useByDay(p.tasks);
  const roomy = p.mode !== 'semana';
  return (
    <div className={`tv-cal-cols is-${p.mode}`} style={{ '--cols': p.days.length } as React.CSSProperties}>
      {p.days.map((iso) => (
        <button key={iso} className={`tv-cal-colhead${iso === today ? ' is-today' : ''}${iso === p.day ? ' is-on' : ''}`} onClick={() => p.onDay(iso)} {...dropOn(iso, setOver, p.onMove)}>
          <span className="tv-cal-coldow">{SHORT_DOW.format(dateOf(iso)).replace('.', '')}</span>
          <span className="tv-cal-num">{Number(iso.slice(8))}</span>
          {!!byDay.get(iso)?.length && <span className="tv-count">{byDay.get(iso)!.filter((r) => r.status !== 'done').length || ''}</span>}
        </button>
      ))}
      {p.days.map((iso) => {
        const list = byDay.get(iso) ?? [];
        return (
          <div key={iso} className={`tv-cal-col${iso === p.day ? ' is-on' : ''}${over === iso ? ' is-over' : ''}${iso < today ? ' is-past' : ''}`} onClick={() => p.onDay(iso)} {...dropOn(iso, setOver, p.onMove)}>
            {list.map((r) => (
              <CalTask key={r.id} r={r} iso={iso} p={p} where={roomy ? p.whereOf(r) : undefined} />
            ))}
            {!list.length && p.mode === 'dia' && <p className="tv-cal-empty">Nada para este día. N para apuntar algo.</p>}
          </div>
        );
      })}
    </div>
  );
}

// Agenda: lo que viene, día a día, solo los días con algo. Si empieza hoy (o antes),
// arriba van las pendientes que ya vencieron.
function CalAgenda(p: CalProps) {
  const [over, setOver] = useState<string | null>(null);
  const today = isoDay(0);
  const byDay = useByDay(p.tasks);
  const late = p.day <= today ? [...byDay.entries()].filter(([iso]) => iso < p.day).flatMap(([iso, list]) => list.filter((r) => r.status !== 'done').map((r) => [iso, r] as const)) : [];
  const days = [...byDay.keys()].filter((iso) => iso >= p.day).sort();
  if (!days.includes(p.day)) days.unshift(p.day);
  const label = (iso: string) => {
    const n = daysUntil(iso);
    return n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : n === -1 ? 'Ayer' : cap(SHORT_DOW.format(dateOf(iso)).replace('.', ''));
  };
  return (
    <div className="tv-agenda">
      {late.length > 0 && (
        <section className="tv-agenda-day is-late">
          <div className="tv-agenda-date">
            <span className="tv-agenda-dow">Vencidas</span>
          </div>
          <div className="tv-agenda-list">
            {late.map(([iso, r]) => (
              <CalTask key={r.id} r={r} iso={iso} p={p} where={[dueLabel(iso), p.whereOf(r)].filter(Boolean).join(' · ')} />
            ))}
          </div>
        </section>
      )}
      {days.map((iso) => {
        const list = byDay.get(iso) ?? [];
        return (
          <section key={iso} className={`tv-agenda-day${iso === today ? ' is-today' : ''}${iso === p.day ? ' is-on' : ''}${over === iso ? ' is-over' : ''}`} {...dropOn(iso, setOver, p.onMove)}>
            <button className="tv-agenda-date" onClick={() => p.onDay(iso)} title="Apuntar en este día">
              <span className="tv-cal-num">{Number(iso.slice(8))}</span>
              <span className="tv-agenda-dow">
                {label(iso)}
                <span className="tv-agenda-month">{MONTH.format(dateOf(iso)).replace(/ de \d+$/, '')}</span>
              </span>
            </button>
            <div className="tv-agenda-list">
              {list.map((r) => (
                <CalTask key={r.id} r={r} iso={iso} p={p} where={p.whereOf(r)} />
              ))}
              {!list.length && <p className="tv-cal-empty">Nada este día.</p>}
            </div>
          </section>
        );
      })}
      {days.length === 1 && !(byDay.get(p.day)?.length) && <p className="tv-cal-empty tv-agenda-end">No hay nada con fecha a partir de aquí.</p>}
    </div>
  );
}
