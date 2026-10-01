import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { parentMap } from './sections';
import { longPress, TOUCH } from './touch';
import type { NoteRow, TaskStatus } from '../api';
import { daysUntil, dueLabel, localToday } from './dates';
import { actionFor, keysBlocked } from '../keys';
import { mergeTags } from './tags';
import { allTasks, type Task, type TaskChange } from './tasks';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { Resizer, useSideWidth } from './Resizer';
import { DatePicker } from './DatePicker';
import { useContextMenu } from './Biblioteca';

// Vista de tareas, fuera del mapa, en tres columnas: a la izquierda las
// listas (Hoy, 7 días, por nota y por etiqueta), en el centro las tareas de la
// elegida (en lista o en tablero por estado) y a la derecha el detalle de la
// señalada.
// Una tarea es una casilla «- [ ]» dentro de una nota; las sangradas bajo otra
// son sus subtareas. Lo que se cambia aquí se escribe en esa nota.

export type TaskGrouping = 'estado' | 'seccion' | 'fecha';
const GROUPINGS: { id: TaskGrouping; label: string }[] = [
  { id: 'fecha', label: 'Fecha' },
  { id: 'estado', label: 'Estado' },
  { id: 'seccion', label: 'Nota' },
];
const STATUSES: { id: TaskStatus; name: string }[] = [
  { id: 'todo', name: 'Pendiente' },
  { id: 'doing', name: 'En curso' },
  { id: 'blocked', name: 'Bloqueada' },
  { id: 'done', name: 'Hecha' },
];
// X avanza; una tarea bloqueada vuelve a pendiente al desbloquearla.
const NEXT: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', blocked: 'todo', done: 'todo' };
const PRIOS = ['Sin prioridad', 'Baja', 'Media', 'Alta'];
const GROUP_KEY = 'canvian.tasksGrouping';
const VIEW_KEY = 'canvian.tasksView';
const LAYOUT_KEY = 'canvian.tasksLayout';
const CAL_KEY = 'canvian.calMode';
const DONE_SHOWN = 20;
/** La nota donde va lo que se apunta sin decir dónde. */
export const INBOX = 'Tareas';

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
const urgency = (r: Task) =>
  (r.status === 'doing' ? 1000 : r.status === 'blocked' ? -1000 : 0) +
  (r.dueAt ? 400 - Math.max(-30, Math.min(60, daysUntil(r.dueAt))) * 5 : 0) +
  r.priority * 60 +
  (r.updatedAt ? Date.parse(r.updatedAt) / 1e11 : 0) -
  r.n / 1e4;

const WEEKDAY = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });
function whenGroup(r: Task): [number, string] {
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
const titleOf = (r: Task) => r.title || 'Tarea sin título';
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
  /** Las notas: sus casillas son las tareas. */
  rows: NoteRow[];
  /** Abre la nota de la tarea, con la tarea a la vista. */
  onOpen: (task: Task) => void;
  onChange: (task: Task, change: TaskChange) => void;
  /** Apunta una tarea en la nota `noteId` (o en «Tareas»), o como subtarea de `under`. */
  onAdd: (source: string, noteId: string | null, extra?: { dueAt?: string }, under?: Task) => void;
  /** Notas en las que puede ir una tarea, con su ruta. */
  sections: SectionOption[];
  onMoveTask: (task: Task, noteId: string) => void;
  onDelete: (task: Task) => void;
  onClose: () => void;
  paused: boolean;
};

export function TasksView(p: Props) {
  const { rows, paused } = p;
  const sideWidth = useSideWidth('canvian.tasksSideWidth', 232, 180, 400);
  const detailWidth = useSideWidth('canvian.tasksDetailWidth', 360, 280, 640);
  const [grouping, setGrouping] = useState<TaskGrouping>(() => {
    const v = read(GROUP_KEY, 'fecha');
    return v === 'estado' || v === 'seccion' ? v : 'fecha';
  });
  const [view, setView] = useState(() => {
    const v = read(VIEW_KEY, 'all');
    return v === 'quick' ? 'all' : v;
  });
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
  // «>» en lo que se apunta: la nota donde meter la tarea, elegida de una lista.
  const [into, setInto] = useState<string | null>(null);
  const [intoCursor, setIntoCursor] = useState(0);
  // Dónde estaba el «>» que se cerró con Esc, para no volver a abrir la lista por él.
  const [intoShut, setIntoShut] = useState(-1);
  const [moving, setMoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

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

  // La nota de cada tarea y su ruta entera («Casa › Cocina»), para el título al pasar el ratón.
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const parent = useMemo(() => parentMap(rows), [rows]);
  const pathOf = (id: string) => {
    const names: string[] = [];
    for (let z = byId.get(id); z && names.length < 20; z = byId.get(parent.get(z.id) ?? '')) names.unshift(noteTitle(z));
    return names.join(' › ');
  };
  const homeOf = (r: Task) => byId.get(r.noteId);

  const all = useMemo(() => allTasks(rows), [rows]);
  const taskById = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const active = useMemo(() => all.filter((r) => r.status !== 'done'), [all]);
  const done = useMemo(() => all.filter((r) => r.status === 'done'), [all]);
  const find = (id: string | null | undefined) => (id ? taskById.get(id) : undefined);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, byId]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of active) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
  }, [active]);

  const due = (r: Task) => (r.dueAt ? daysUntil(r.dueAt) : null);
  const smart: { id: string; name: string; icon: string; test: (r: Task) => boolean }[] = [
    { id: 'all', name: 'Todas', icon: '◎', test: () => true },
    { id: 'today', name: 'Hoy', icon: '◐', test: (r) => due(r) !== null && due(r)! <= 0 },
    { id: 'week', name: 'Próximos 7 días', icon: '◔', test: (r) => due(r) !== null && due(r)! <= 7 },
  ];

  const current = useMemo(() => {
    if (view === 'done') return { name: 'Hechas', list: [...done].sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || b.updatedAt.localeCompare(a.updatedAt)), test: () => true };
    let name: string;
    let test: (r: Task) => boolean;
    if (view.startsWith('sec:')) {
      const id = view.slice(4);
      name = byId.get(id) ? noteTitle(byId.get(id)!) : 'Nota';
      test = (r) => r.noteId === id;
    } else if (view.startsWith('tag:')) {
      const t = view.slice(4).toLowerCase();
      name = `#${view.slice(4)}`;
      test = (r) => r.tags.some((x) => x.toLowerCase() === t);
    } else {
      const s = smart.find((x) => x.id === view) ?? smart[0];
      name = s.name;
      test = s.test;
    }
    return { name, list: active.filter(test), test };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, active, done, byId]);

  // Cada grupo en su orden: lo que más urge arriba y, bajo cada tarea, sus
  // subtareas que estén en el mismo grupo (en el orden en que están escritas).
  const groups = useMemo(() => {
    const nest = (items: Task[], sort: (a: Task, b: Task) => number) => {
      const here = new Set(items.map((r) => r.id));
      const out: { task: Task; depth: number }[] = [];
      const put = (r: Task, depth: number) => {
        out.push({ task: r, depth });
        for (const k of r.kids) if (here.has(k)) put(taskById.get(k)!, depth + 1);
      };
      for (const r of [...items].sort(sort)) if (!r.parentId || !here.has(r.parentId)) put(r, 0);
      return out;
    };
    if (view === 'done') return current.list.length ? [{ key: 0 as number | string, title: 'Hechas', items: nest(current.list, () => 0) }] : [];
    const out = new Map<string, { key: number | string; title: string; items: Task[] }>();
    for (const r of current.list) {
      let key: number | string;
      let title: string;
      // Dos notas con el mismo nombre en sitios distintos son dos grupos.
      let at: string | undefined;
      if (grouping === 'estado') [key, title] = r.status === 'doing' ? [0, 'En curso'] : r.status === 'blocked' ? [2, 'Bloqueadas'] : [1, 'Por hacer'];
      else if (grouping === 'fecha') [key, title] = whenGroup(r);
      else {
        const home = homeOf(r);
        at = r.noteId;
        title = home ? noteTitle(home) : 'Nota';
        key = `${title.toLocaleLowerCase('es')}\u0000${r.noteId}`;
      }
      const g = out.get(at ?? title) ?? { key, title, items: [] };
      g.items.push(r);
      out.set(at ?? title, g);
    }
    const list = [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return list.map((g) => ({ ...g, items: nest(g.items, (a, b) => urgency(b) - urgency(a)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, grouping, view, taskById]);

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
      const mine = s.id === 'done' ? done.filter(current.test).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || b.updatedAt.localeCompare(a.updatedAt)) : current.list.filter((r) => r.status === s.id).sort((a, b) => urgency(b) - urgency(a));
      return { ...s, items: mine.slice(0, s.id === 'done' ? DONE_SHOWN : undefined), total: mine.length };
    });
  }, [board, current, done]);
  const colOf = (id: string | null) => columns.findIndex((c) => c.items.some((r) => r.id === id));
  const firstCard = columns.find((c) => c.items.length)?.items[0] ?? null;
  const boardCur = colOf(cursorId) >= 0 ? cursorId : (firstCard?.id ?? null);
  const moveTo = (r: Task, s: TaskStatus) => {
    if (r.status !== s) p.onChange(r, { status: s });
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

  const flat = cal || board ? [] : groups.flatMap((g) => (collapsed.has(g.title) ? [] : g.items.map((x) => x.task)));
  const found = flat.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : Math.min(lastAt.current, Math.max(0, flat.length - 1));
  lastAt.current = at;
  const cur = cal ? (find(calSel) ?? null) : board ? (find(boardCur) ?? null) : (flat[at] ?? null);
  const setCursor = (idx: number) => setCursorId(flat[idx]?.id ?? null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tv-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  useEffect(() => {
    if (board) document.querySelector<HTMLElement>('.tv-card.is-cursor')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [board, boardCur]);

  const toggleDone = (r: Task) => p.onChange(r, { status: r.status === 'done' ? 'todo' : 'done' });
  const cycle = (r: Task) => p.onChange(r, { status: NEXT[r.status] });
  const block = (r: Task) => p.onChange(r, { status: r.status === 'blocked' ? 'todo' : 'blocked' });
  // De qué tarea es subtarea, y cuántas de las suyas están hechas.
  const upOf = (r: Task) => (r.parentId ? find(r.parentId) : undefined);
  const kidsDone = (r: Task) => r.kids.filter((k) => find(k)?.status === 'done').length;

  // Clic derecho sobre una tarea: la señala y abre el menú donde está el ratón.
  const openMenu = (e: React.MouseEvent, r: Task) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id: r.id, x: e.clientX, y: e.clientY });
  };
  const menuPick = (r: Task, a: TaskMenuAction) => {
    if (a === 'open') p.onOpen(r);
    else if (a === 'edit') {
      setCursorId(r.id);
      setTimeout(() => titleRef.current?.focus(), 0);
    } else if (a === 'done') toggleDone(r);
    else if (a === 'move') setMoving(r.id);
    else if (a === 'delete') p.onDelete(r);
    else if ('status' in a) moveTo(r, a.status);
    else if ('priority' in a) p.onChange(r, { priority: a.priority });
    else p.onChange(r, { dueAt: a.dueAt });
  };

  // «Tarea >proy»: lo que va tras el último «>» busca la nota donde meterla.
  const gt = adding.lastIndexOf('>');
  const intoQuery = gt >= 0 && gt !== intoShut ? adding.slice(gt + 1) : null;
  // Van dentro de notas de texto, no de un canvas.
  const intoOptions = useMemo(() => p.sections.filter((o) => o.id && byId.get(o.id)?.kind !== 'canvas'), [p.sections, byId]);
  const intoItems = useMemo(() => (intoQuery === null ? [] : matchNotes(intoOptions, intoQuery)), [intoQuery, intoOptions]);
  const intoAt = Math.min(intoCursor, Math.max(0, intoItems.length - 1));
  const intoPath = into ? (p.sections.find((o) => o.id === into)?.path ?? null) : null;
  const pickInto = (id: string) => {
    setInto(id);
    setAdding(adding.slice(0, gt).trimEnd());
    setIntoCursor(0);
    addRef.current?.focus();
  };

  // Lo que se apunta arriba va a la lista elegida: con su fecha, su etiqueta o dentro de su nota
  // (la elegida con «>», la de la lista si es la de una nota, o si no «Tareas»).
  const add = () => {
    const raw = adding.trim();
    if (!raw) return;
    const text = view.startsWith('tag:') ? `${raw} #${view.slice(4)}` : raw;
    const extra = view === 'today' ? { dueAt: isoDay(0) } : cal ? { dueAt: calDay } : {};
    const zone = (intoPath && into) || (view.startsWith('sec:') ? view.slice(4) : null);
    p.onAdd(text, zone, extra);
    setAdding('');
    setInto(null);
    setIntoShut(-1);
  };
  const addHint = cal
    ? `Añadir tarea para ${calDay === isoDay(0) ? 'hoy' : dueLabel(calDay)}…`
    : view.startsWith('sec:') ? `Añadir tarea en ${current.name}…` : view === 'today' ? 'Añadir tarea para hoy…' : `Añadir tarea en «${INBOX}»… (#etiqueta, > otra nota)`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || moving || menu || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const action = actionFor(e, ['tasks', 'cycleStatus', 'blockTask', 'newNote', 'deleteCell']);
      const k = e.metaKey || e.ctrlKey || e.altKey ? '' : e.key.toLowerCase();
      if (k === 'escape' || action === 'tasks') p.onClose();
      else if (action === 'cycleStatus') cur && cycle(cur);
      else if (action === 'blockTask') cur && block(cur);
      else if (action === 'newNote') addRef.current?.focus();
      else if (action === 'deleteCell') cur && p.onDelete(cur);
      // La tecla de menú (o Mayús F10) abre el menú de la señalada, junto a ella.
      else if ((k === 'contextmenu' || (k === 'f10' && e.shiftKey)) && cur) {
        const box = document.querySelector('.tv-row.is-cursor, .tv-card.is-cursor, .tv-cal-task.is-sel')?.getBoundingClientRect();
        setMenu({ id: cur.id, x: box ? box.left + 24 : innerWidth / 2, y: box ? box.bottom : innerHeight / 3 });
      } else if (k === ' ' && cur) toggleDone(cur);
      else if (k === 'm' && cur) setMoving(cur.id);
      else if (k === 'e' && cur) titleRef.current?.focus();
      else if (k === 'v' && view !== 'done' && !cal) pickLayout(board ? 'lista' : 'tablero');
      else if (board && e.shiftKey && (k === 'arrowleft' || k === 'arrowright' || k === 'h' || k === 'l') && cur) {
        const n = STATUSES.findIndex((s) => s.id === cur.status) + (k === 'arrowleft' || k === 'h' ? -1 : 1);
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
      else if (k === 'enter' && cur) p.onOpen(cur);
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

  // Dónde está una tarea, para enseñarlo junto a ella: su nota y, si su tarea
  // madre no está al lado, también esa.
  const whereOf = (r: Task, withNote = true) => {
    const up = upOf(r);
    return [withNote ? (homeOf(r) ? noteTitle(homeOf(r)!) : '') : '', up ? `↳ ${titleOf(up)}` : ''].filter(Boolean).join(' · ');
  };

  let i = 0;
  return (
    <div className="tasks-view tv" style={{ '--tv-side-w': `${sideWidth.width}px`, '--tv-detail-w': `${detailWidth.width}px` } as CSSProperties}>
      <nav className="tv-side" aria-label="Listas de tareas">
        {smart.map((s) => (
          <Nav key={s.id} id={s.id} name={s.name} icon={s.icon} n={active.filter(s.test).length} />
        ))}
        {sections.length > 0 && <div className="tv-side-title">En las notas</div>}
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
            {intoPath && (
              <span className="tv-add-into" title={intoPath}>
                <span className="tv-add-into-name">{intoPath.split(' › ').at(-1)}</span>
                <button onClick={() => (setInto(null), addRef.current?.focus())} aria-label="Quitar la nota" title="Quitar la nota">
                  ×
                </button>
              </span>
            )}
            <input
              ref={addRef}
              placeholder={intoPath ? 'Tarea dentro de esta nota…' : addHint}
              aria-label="Añadir tarea"
              aria-expanded={intoQuery !== null}
              aria-controls="tv-add-menu"
              value={adding}
              onChange={(e) => {
                setAdding(e.target.value);
                setIntoCursor(0);
                if (e.target.value.lastIndexOf('>') !== intoShut) setIntoShut(-1);
              }}
              onKeyDown={(e) => {
                const menu = intoQuery !== null;
                if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) setIntoCursor((intoAt + (e.key === 'ArrowDown' ? 1 : -1) + intoItems.length) % Math.max(1, intoItems.length));
                else if (menu && (e.key === 'Enter' || e.key === 'Tab')) {
                  // Sin ninguna nota que case, Enter no apunta nada: Esc cierra la lista y deja el «>» como texto.
                  if (intoItems[intoAt]) pickInto(intoItems[intoAt].id!);
                } else if (menu && e.key === 'Escape') setIntoShut(gt);
                else if (e.key === 'Backspace' && into && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) setInto(null);
                else if (e.key === 'Enter') add();
                else if (e.key === 'Escape') e.currentTarget.blur();
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onFocus={() => setIntoShut(-1)}
              onBlur={() => setTimeout(() => document.activeElement !== addRef.current && gt >= 0 && setIntoShut(gt), 0)}
            />
            <span className="tv-add-key">N</span>
            {intoQuery !== null && (
              <div className="surface-3 tv-add-menu" id="tv-add-menu" role="listbox" aria-label="Meter la tarea dentro de" onMouseDown={(e) => e.preventDefault()}>
                {intoItems.length === 0 ? (
                  <div className="list-item static">{intoQuery.trim() ? 'Ninguna nota se llama así · Esc para dejar el «>»' : 'Escribe el nombre de una nota'}</div>
                ) : (
                  <ul className="list">
                    {intoItems.map((o, n) => (
                      <li key={o.id} role="option" aria-selected={n === intoAt} className="list-item" onMouseEnter={() => setIntoCursor(n)} onClick={() => pickInto(o.id!)}>
                        <div className="hit">
                          <span className="hit-title">{o.path.split(' › ').at(-1)}</span>
                          {o.path.includes(' › ') && <span className="hit-snippet">en {o.path.split(' › ').slice(0, -1).join(' › ')}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
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
            whereOf={(r) => whereOf(r)}
            onDay={pickDay}
            onSelect={(r) => {
              setCalSel(r.id);
              // En la agenda, el día elegido es desde dónde empieza: señalar no la mueve.
              if (r.dueAt && calMode !== 'agenda') (calMode === 'mes' ? setCalDay : pickDay)(r.dueAt.slice(0, 10));
            }}
            onOpen={p.onOpen}
            onToggle={toggleDone}
            onMove={(id, iso) => {
              const r = find(id);
              if (r) p.onChange(r, { dueAt: iso });
            }}
            onMenu={(e, r) => {
              setCalSel(r.id);
              openMenu(e, r);
            }}
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
                  const r = find(e.dataTransfer.getData('text/plain'));
                  if (r) moveTo(r, c.id);
                }}
              >
                <h2 className="tv-col-title">
                  {c.name} <span className="tv-count">{c.total}</span>
                </h2>
                <div className="tv-col-list">
                  {c.items.map((r) => {
                    const d = due(r);
                    const where = whereOf(r);
                    return (
                      <div
                        key={r.id}
                        draggable={!TOUCH}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', r.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        className={`tv-card${r.id === boardCur ? ' is-cursor' : ''}${r.status === 'done' ? ' is-done' : ''}`}
                        onMouseDown={() => setCursorId(r.id)}
                        onClick={() => window.innerWidth <= 1100 && p.onOpen(r)}
                        onDoubleClick={() => p.onOpen(r)}
                        onContextMenu={(e) => openMenu(e, r)}
                        {...longPress((x, y) => setMenu({ id: r.id, x, y }))}
                      >
                        <div className="tv-card-top">
                          <Check row={r} onToggle={() => toggleDone(r)} />
                          <span className="tv-card-title">{titleOf(r)}</span>
                          {r.kids.length > 0 && <span className="tv-kids">{`${kidsDone(r)}/${r.kids.length}`}</span>}
                        </div>
                        {(where || r.dueAt || r.tags.length > 0) && (
                          <div className="tv-card-meta">
                            {r.dueAt && <span className={`tv-due${d! < 0 && r.status !== 'done' ? ' is-late' : d === 0 ? ' is-today' : ''}`}>{dueLabel(r.dueAt)}</span>}
                            {r.tags.map((x) => (
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
          {!groups.length && (
            <p className="tv-empty">{view === 'done' ? 'Aún no hay nada hecho.' : all.length ? 'Nada pendiente aquí.' : 'Aún no hay tareas. Escribe «- [ ] » en cualquier nota, o apunta una arriba.'}</p>
          )}
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
                  g.items.map(({ task: r, depth }) => {
                    const idx = i++;
                    const d = due(r);
                    // Una subtarea bajo su madre no repite dónde está.
                    const where = depth ? '' : whereOf(r, grouping !== 'seccion' && !view.startsWith('sec:'));
                    return (
                      <div
                        key={r.id}
                        className={`tv-row${idx === at ? ' is-cursor' : ''}${r.status === 'done' ? ' is-done' : ''}${depth ? ' is-sub' : ''}`}
                        style={depth ? ({ '--depth': depth } as CSSProperties) : undefined}
                        onMouseDown={() => setCursor(idx)}
                        // Sin sitio para el detalle (pantallas estrechas), un toque abre la nota.
                        onClick={() => window.innerWidth <= 1100 && p.onOpen(r)}
                        onDoubleClick={() => p.onOpen(r)}
                        onContextMenu={(e) => openMenu(e, r)}
                        {...longPress((x, y) => setMenu({ id: r.id, x, y }))}
                      >
                        <Check row={r} onToggle={() => toggleDone(r)} />
                        <span className="tv-row-title">{titleOf(r)}</span>
                        {r.kids.length > 0 && <span className="tv-kids" title="Subtareas hechas">{`${kidsDone(r)}/${r.kids.length}`}</span>}
                        {r.tags.map((t) => (
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
              ? '←→↑↓ moverse · Mayús ←→ cambiar de columna · arrastra una tarjeta · Espacio hecha · M otra nota · V lista · Esc salir'
              : '↑↓ moverse · Espacio hecha · X estado · Enter abrir la nota · E editar · M otra nota · N añadir (> en una nota) · Tab agrupar · V tablero · Esc salir'}
        </p>
      </main>

      <Resizer size={detailWidth} edge="left" className="tv-resizer" />
      <Detail
        key={cur ? `${cur.id}\u0000${cur.source}` : 'none'}
        row={cur}
        p={p}
        find={find}
        section={cur && homeOf(cur) ? noteTitle(homeOf(cur)!) : ''}
        path={cur ? pathOf(cur.noteId) : ''}
        titleRef={titleRef}
        onToggle={toggleDone}
        onPick={(r) => setCursorId(r.id)}
        onMove={() => cur && setMoving(cur.id)}
      />
      {menu && find(menu.id) && <TaskMenu row={find(menu.id)!} x={menu.x} y={menu.y} onPick={(a) => menuPick(find(menu.id)!, a)} onClose={() => setMenu(null)} />}
      {moving && find(moving) && (
        <SectionPicker
          options={intoOptions}
          current={find(moving)!.noteId}
          exclude={new Set()}
          onPick={(noteId) => {
            if (noteId) p.onMoveTask(find(moving)!, noteId);
            setMoving(null);
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

// La casilla: vacía, con punto (en curso), con raya (bloqueada) o marcada.
function Check({ row, onToggle }: { row: Task; onToggle: () => void }) {
  const s = row.status;
  return (
    <button
      className={`tv-check is-${s} prio-${row.priority}`}
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
  find,
  section,
  path,
  titleRef,
  onToggle,
  onPick,
  onMove,
}: {
  row: Task | null;
  p: Props;
  find: (id: string | null | undefined) => Task | undefined;
  // La nota de la tarea y, para el título al pasar el ratón, su ruta entera.
  section: string;
  path: string;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onToggle: (r: Task) => void;
  onPick: (r: Task) => void;
  onMove: () => void;
}) {
  const [title, setTitle] = useState(row?.source ?? '');
  const [tag, setTag] = useState('');
  const [sub, setSub] = useState('');
  if (!row) return <aside className="tv-detail tv-detail-empty">Elige una tarea para ver su detalle.</aside>;
  const up = row.parentId ? find(row.parentId) : undefined;
  const kids = row.kids.map((k) => find(k)).filter((k): k is Task => !!k);

  const saveTitle = () => {
    const t = title.trim();
    if (!t || t === row.source) return setTitle(row.source);
    p.onChange(row, { source: t });
  };

  return (
    <aside className="tv-detail" aria-label="Detalle de la tarea">
      <div className="tv-detail-bar">
        <Check row={row} onToggle={() => onToggle(row)} />
        <DatePicker
          className={`tv-date${row.dueAt && daysUntil(row.dueAt) < 0 && row.status !== 'done' ? ' is-late' : ''}`}
          label="Fecha"
          value={row.dueAt?.slice(0, 10) ?? null}
          onChange={(v) => p.onChange(row, { dueAt: v })}
        />
        <div className="tv-prio" role="radiogroup" aria-label="Prioridad">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={row.priority === n}
              title={PRIOS[n]}
              className={`prio-${n}${row.priority === n ? ' is-on' : ''}`}
              onClick={() => p.onChange(row, { priority: row.priority === n ? 0 : n })}
            >
              {'!'.repeat(n)}
            </button>
          ))}
        </div>
      </div>

      {up && (
        <button className="tv-detail-up" onClick={() => onPick(up)} title="Ir a la tarea madre">
          ↳ Subtarea de <span>{titleOf(up)}</span>
        </button>
      )}
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
            setTitle(row.source);
            e.currentTarget.blur();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <button className="tv-detail-where" onClick={onMove} title={`${path} · llevarla a otra nota (M)`}>
        En {section || 'una nota'}
        <span className="tv-detail-move">Mover</span>
      </button>

      <div className="tv-status" role="radiogroup" aria-label="Estado">
        {STATUSES.map((s) => (
          <button key={s.id} role="radio" aria-checked={row.status === s.id} className={row.status === s.id ? 'is-on' : ''} onClick={() => p.onChange(row, { status: s.id })}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="tv-detail-tags">
        {row.tags.map((t) => (
          <button key={t} className="tv-tag is-chip" title="Quitar" onClick={() => p.onChange(row, { tags: row.tags.filter((x) => x !== t) })}>
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
              p.onChange(row, { tags: mergeTags(row.tags, [t]) });
              setTag('');
            }
            e.stopPropagation();
          }}
        />
      </div>

      <div className="tv-subs" aria-label="Subtareas">
        <span className="tv-subs-h">
          Subtareas{kids.length > 0 && <span className="tv-count">{`${kids.filter((k) => k.status === 'done').length}/${kids.length}`}</span>}
        </span>
        {kids.map((k) => (
          <div key={k.id} className={`tv-sub${k.status === 'done' ? ' is-done' : ''}`} onClick={() => onPick(k)}>
            <Check row={k} onToggle={() => onToggle(k)} />
            <span className="tv-sub-title">{titleOf(k)}</span>
            {k.kids.length > 0 && <span className="tv-kids">{`${k.kids.filter((x) => find(x)?.status === 'done').length}/${k.kids.length}`}</span>}
          </div>
        ))}
        <input
          className="tv-sub-add"
          placeholder="+ subtarea"
          aria-label="Añadir subtarea"
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sub.trim()) {
              e.preventDefault();
              p.onAdd(sub.trim(), row.noteId, {}, row);
              setSub('');
            } else if (e.key === 'Escape') e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
      </div>

      <div className="tv-detail-foot">
        <button className="set-button tv-danger" onClick={() => p.onDelete(row)} title={kids.length ? 'Borrar la tarea y sus subtareas (Supr)' : 'Borrar la tarea (Supr)'}>
          Borrar
        </button>
        <button className="set-button tv-expand" onClick={() => p.onOpen(row)} title="Abrir su nota (Enter)" aria-label="Abrir su nota">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

// ── Menú con clic derecho ─────────────────────────────────────────────

export type TaskMenuAction = 'open' | 'edit' | 'done' | 'move' | 'delete' | { status: TaskStatus } | { priority: number } | { dueAt: string | null };

function TaskMenu({ row, x, y, onPick, onClose }: { row: Task; x: number; y: number; onPick: (a: TaskMenuAction) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const s = row.status;
  const dueDay = row.dueAt?.slice(0, 10) ?? null;
  const pick = (a: TaskMenuAction) => {
    onClose();
    onPick(a);
  };
  const item = (a: TaskMenuAction, label: string, k?: string, danger?: boolean) => (
    <button key={label} role="menuitem" className={`bib-menu-it${danger ? ' is-danger' : ''}`} onClick={() => pick(a)}>
      {label}
      {k && <span className="bib-menu-k">{k}</span>}
    </button>
  );
  // Estado, prioridad y fecha, en una fila de botones cada uno.
  const chips = (label: string, items: { a: TaskMenuAction; name: string; on: boolean; title?: string; className?: string }[]) => (
    <div key={label} className="tv-menu-row" role="group" aria-label={label}>
      <span className="tv-menu-label">{label}</span>
      <div className="tv-menu-chips">
        {items.map((it) => (
          <button key={it.name} role="menuitemradio" aria-checked={it.on} className={`tv-menu-chip${it.on ? ' is-on' : ''}${it.className ? ` ${it.className}` : ''}`} title={it.title ?? it.name} onClick={() => pick(it.a)}>
            {it.name}
          </button>
        ))}
      </div>
    </div>
  );
  const soon = [
    { iso: isoDay(0), name: 'Hoy' },
    { iso: isoDay(1), name: 'Mañana' },
    { iso: isoDay(7), name: '+1 sem.', title: 'Dentro de una semana' },
  ];

  // En <body>: la vista de tareas entra con un transform, y dentro de ella «fixed» no se mediría desde la ventana.
  return createPortal(
    <div className="bib-menu tv-menu" ref={ref} role="menu" aria-label={titleOf(row)} style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="bib-menu-head bib-ellipsis">{titleOf(row)}</div>
      {item('open', 'Abrir su nota', 'Enter')}
      {item('edit', 'Editar el texto', 'E')}
      {item('done', s === 'done' ? 'Marcar pendiente' : 'Marcar hecha', 'Espacio')}
      <div className="bib-menu-sep" role="separator" />
      {chips('Estado', STATUSES.map((x) => ({ a: { status: x.id }, name: x.name, on: s === x.id })))}
      {chips('Prioridad', [0, 1, 2, 3].map((n) => ({ a: { priority: n }, name: n ? '!'.repeat(n) : '—', title: PRIOS[n], on: row.priority === n, className: `prio-${n}` })))}
      {chips('Fecha', [
        ...soon.map((d) => ({ a: { dueAt: d.iso }, name: d.name, title: d.title ?? dueLabel(d.iso), on: dueDay === d.iso })),
        { a: { dueAt: null }, name: 'Sin fecha', on: !dueDay },
      ])}
      <div className="bib-menu-sep" role="separator" />
      {item('move', 'Llevar a otra nota…', 'M')}
      <div className="bib-menu-sep" role="separator" />
      {item('delete', row.kids.length ? 'Borrar con sus subtareas' : 'Borrar', 'Supr', true)}
    </div>,
    document.body,
  );
}

// Las notas que casan con lo escrito tras «>»: primero por el nombre (exacto, que
// empieza así, que lo contiene) y luego por la ruta. Como mucho ocho.
const normQ = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
function matchNotes(options: SectionOption[], query: string) {
  const q = normQ(query);
  const words = q.split(/\s+/).filter(Boolean);
  const hits: { o: SectionOption; score: number }[] = [];
  for (const o of options) {
    if (!o.id) continue;
    const name = normQ(o.path.split(' › ').at(-1) ?? '');
    const path = normQ(o.path);
    const score = !words.length ? 3 : name === q ? 0 : name.startsWith(q) ? 1 : words.every((w) => name.includes(w)) ? 2 : words.every((w) => path.includes(w)) ? 4 : -1;
    if (score >= 0) hits.push({ o, score });
  }
  hits.sort((a, b) => a.score - b.score || a.o.path.length - b.o.path.length);
  return hits.slice(0, 8).map((h) => h.o);
}

// Las tareas con fecha, por día; en cada uno, primero las pendientes y lo que más urge.
function useByDay(tasks: Task[]) {
  return useMemo(() => {
    const out = new Map<string, Task[]>();
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
  tasks: Task[];
  selected: string | null;
  whereOf: (r: Task) => string;
  onDay: (iso: string) => void;
  onSelect: (r: Task) => void;
  onOpen: (r: Task) => void;
  onToggle: (r: Task) => void;
  onMove: (id: string, iso: string) => void;
  onMenu: (e: React.MouseEvent, r: Task) => void;
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
function CalTask({ r, iso, p, where }: { r: Task; iso: string; p: CalProps; where?: string }) {
  const today = isoDay(0);
  return (
    <div
      className={`tv-cal-task${r.status === 'done' ? ' is-done' : ''}${r.id === p.selected ? ' is-sel' : ''}${r.status !== 'done' && iso < today ? ' is-late' : ''}`}
      draggable={!TOUCH}
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
      onContextMenu={(e) => p.onMenu(e, r)}
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
