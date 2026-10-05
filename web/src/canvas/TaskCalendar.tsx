import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { t } from '../i18n';
import { dateFmt, daysUntil, dueLabel } from './dates';
import { dayDiff, nextDate, parseRecur, shiftDay, spans, type Task, type TaskChange } from './tasks';
import { repeatLabel } from './repeat';
import type { CalEvent, ExternalCalendar } from '../calendars';
import { addDays, cap, Check, dateOf, isoDay, isoOf, titleOf, urgency, type CalMode } from './TasksView';

// El calendario de la vista de tareas: mes, agenda y, en «Día», «3 días» y
// «Semana», una rejilla de horas como la de Google Calendar.
//
// Una tarea va del día `startAt` (si dura varios) al `dueAt`, y puede tener
// horas («⏰ 10:00-11:30»). Lo de varios días se pinta como una barra que los
// cruza; lo que tiene horas, como un bloque en su hueco. Todo se arrastra:
// sobre días vacíos se eligen varios para apuntar una tarea que los ocupe,
// sobre horas vacías un hueco, y una tarea se mueve o se estira por su borde.
// En el móvil, lo mismo manteniendo pulsado antes de arrastrar.

/** Un trozo de calendario: del día `first` al `last`, de todo el día o con horas. */
export type Shape = { first: string; last: string; startTime: string | null; endTime: string | null };

/** Una tarea en el calendario; `of`, si es una de las próximas veces de una que se repite. */
type CalItem = Task & { of?: Task };

// Un evento de un calendario de fuera en un día: los de varios días salen en cada uno.
export type DayEvent = CalEvent & { time: string | null };

export type CalProps = {
  mode: CalMode;
  month: string;
  // Los días a la vista en «Día», «3 días» y «Semana».
  days: string[];
  day: string;
  tasks: Task[];
  /** Eventos de los calendarios de fuera, por día. */
  events: Map<string, DayEvent[]>;
  calendars: ExternalCalendar[];
  selected: string | null;
  /** Lo elegido arrastrando, donde se apuntará la próxima tarea. */
  range: Shape | null;
  whereOf: (r: Task) => string;
  onDay: (iso: string) => void;
  onSelect: (r: Task) => void;
  onOpen: (r: Task) => void;
  onToggle: (r: Task) => void;
  onMenu: (x: number, y: number, r: Task) => void;
  /** Se han elegido días (o un hueco de horas) arrastrando. */
  onRange: (s: Shape) => void;
  /** Una tarea movida o estirada. */
  onPlace: (r: Task, change: TaskChange) => void;
};

const HOUR = 44; // px por hora en la rejilla
const SNAP = 15; // minutos
const BAR = 20; // alto de una barra en el mes
const MAX_LANES = 3;
const EPOCH = '2000-01-01';

const DOW = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MONTH_NAME = () => dateFmt({ month: 'long' });
const SHORT_DOW = () => dateFmt({ weekday: 'short' });
const SHORT_DAY = () => dateFmt({ day: 'numeric', month: 'short' });
const TIME = () => dateFmt({ hour: '2-digit', minute: '2-digit' });

// ── Días y minutos ────────────────────────────────────────────────────
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Minutos desde una fecha fija: así se suman días y horas de una vez.
const abs = (day: string, m: number) => dayDiff(EPOCH, day) * 1440 + m;
const unabs = (a: number) => ({ day: shiftDay(EPOCH, Math.floor(a / 1440)), m: ((a % 1440) + 1440) % 1440 });
const snap = (m: number) => Math.round(m / SNAP) * SNAP;

const firstDay = (r: Task) => (spans(r) ? r.startAt! : r.dueAt!).slice(0, 10);
const lastDay = (r: Task) => r.dueAt!.slice(0, 10);
const shapeOf = (r: Task): Shape => ({ first: firstDay(r), last: lastDay(r), startTime: r.startTime, endTime: r.endTime });

/** Inicio y fin, en minutos, de algo con horas (sin hora de fin, dura una hora). */
function span(s: Shape): [number, number] {
  const a = abs(s.first, mins(s.startTime!));
  const b = s.endTime ? abs(s.last, mins(s.endTime)) : a + 60;
  return [a, b > a ? b : a + 60];
}
// Lo que acaba a medianoche acaba a las 23:59 de ese día, no al empezar el siguiente.
function shapeFrom(a: number, b: number): Shape {
  const s = unabs(a);
  const e = unabs(b % 1440 === 0 && b > a ? b - 1 : b);
  return { first: s.day, last: e.day, startTime: hhmm(s.m), endTime: hhmm(e.m) };
}

/** Lo que cambia en la tarea para que ocupe `s` (solo lo distinto). */
function changeFor(r: Task, s: Shape): TaskChange {
  const c: TaskChange = {};
  const startAt = s.first < s.last ? s.first : null;
  if (s.last !== r.dueAt?.slice(0, 10)) c.dueAt = s.last;
  if (startAt !== (r.startAt?.slice(0, 10) ?? null)) c.startAt = startAt;
  if (s.startTime !== r.startTime) c.startTime = s.startTime;
  if (s.startTime && s.endTime !== r.endTime) c.endTime = s.endTime;
  return c;
}

/** «10:00–11:30», «10:00» o ''. */
export const timeLabel = (r: { startTime: string | null; endTime: string | null }) => (r.startTime ? (r.endTime ? `${r.startTime}–${r.endTime}` : r.startTime) : '');
/** Cómo se dice lo elegido: «lun 5, 10:00–11:30», «5 oct – 8 oct». */
export function shapeLabel(s: Shape) {
  const day = (iso: string) => (s.first === s.last ? dueLabel(iso) : SHORT_DAY().format(dateOf(iso)));
  const when = s.first === s.last ? day(s.first) : `${day(s.first)} – ${day(s.last)}`;
  return s.startTime ? `${when}, ${timeLabel(s)}` : when;
}

// En cada día: primero lo de verdad, lo pendiente y lo de antes; luego lo que más urge.
const order = (a: CalItem, b: CalItem) =>
  Number(!!a.of) - Number(!!b.of) || Number(a.status === 'done') - Number(b.status === 'done') || (a.startTime ?? '').localeCompare(b.startTime ?? '') || urgency(b) - urgency(a);

// Las tareas con fecha y, entre `from` y `to` (sin incluirlo), las próximas
// veces de las que se repiten a partir de hoy (con lo mismo que duren).
function useItems(tasks: Task[], from: string, to: string) {
  return useMemo(() => {
    const out: CalItem[] = [];
    const today = isoDay(0);
    for (const r of tasks) {
      if (!r.dueAt) continue;
      out.push(r);
      const rule = r.repeat && r.status !== 'done' ? parseRecur(r.repeat) : null;
      if (!rule) continue;
      const due = lastDay(r);
      const len = dayDiff(firstDay(r), due);
      for (let d = nextDate(rule, due), n = 0; shiftDay(d, -len) < to && n < 3000; d = nextDate(rule, d), n++) {
        if (d >= from && d >= today) out.push({ ...r, id: `${r.id}@${d}`, dueAt: d, startAt: len ? shiftDay(d, -len) : r.startAt, of: r });
      }
    }
    return out.sort(order);
  }, [tasks, from, to]);
}

// Barras por carriles: cada una en el primero libre (s y e, días incluidos).
function lanes<T>(segs: { it: T; s: number; e: number }[]) {
  const ends: number[] = [];
  const list = [...segs]
    .sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s))
    .map((g) => {
      let lane = ends.findIndex((e) => e < g.s);
      if (lane < 0) lane = ends.push(0) - 1;
      ends[lane] = g.e;
      return { ...g, lane };
    });
  return { list, count: ends.length };
}

// Bloques que se pisan en una columna de horas: lado a lado, como en Google.
function columns<T>(segs: { it: T; a: number; b: number }[]) {
  const out: { it: T; a: number; b: number; col: number; cols: number }[] = [];
  let group: typeof out = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const g of group) g.cols = ends.length;
    group = [];
    ends = [];
  };
  for (const s of [...segs].sort((x, y) => x.a - y.a || y.b - x.b)) {
    if (s.a >= groupEnd) flush();
    let col = ends.findIndex((e) => e <= s.a);
    if (col < 0) col = ends.push(0) - 1;
    ends[col] = s.b;
    const blk = { ...s, col, cols: 1 };
    group.push(blk);
    out.push(blk);
    groupEnd = Math.max(groupEnd, s.b);
  }
  flush();
  return out;
}

/** Los eventos por día local entre `from` y `to`; en cada día, primero los de día completo y luego por hora. */
export function byDayOf(events: CalEvent[], from: string, to: string) {
  const out = new Map<string, DayEvent[]>();
  const add = (iso: string, e: DayEvent) => {
    if (iso >= from && iso < to) out.set(iso, [...(out.get(iso) ?? []), e]);
  };
  for (const e of events) {
    if (e.allDay) {
      for (let d = e.start, n = 0; d < e.end && n < 400; d = addDays(d, 1), n++) add(d, { ...e, time: null });
      continue;
    }
    const start = new Date(e.start);
    const end = new Date(e.end);
    const first = isoOf(start);
    // Lo que acaba justo a medianoche no ocupa el día siguiente.
    const last = end > start ? isoOf(new Date(end.getTime() - 1)) : first;
    for (let d = first, n = 0; d <= last && n < 400; d = addDays(d, 1), n++) add(d, { ...e, time: d === first ? TIME().format(start) : null });
  }
  for (const list of out.values()) list.sort((a, b) => Number(!!a.time) - Number(!!b.time) || a.start.localeCompare(b.start));
  return out;
}

// ── Arrastrar ─────────────────────────────────────────────────────────
// Lo que hay bajo el dedo o el ratón: una columna de horas (con su minuto),
// una franja de «todo el día» o un día del mes (o de la agenda).
type Hit = { day: string; m: number | null; zone: 'col' | 'allday' | 'day' };
function hitAt(x: number, y: number): Hit | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.col) {
      const r = el.getBoundingClientRect();
      return { day: el.dataset.col, m: Math.max(0, Math.min(1439, ((y - r.top) / r.height) * 1440)), zone: 'col' };
    }
    if (el.dataset.day) return { day: el.dataset.day, m: null, zone: 'allday' in el.dataset ? 'allday' : 'day' };
  }
  return null;
}

type Grab =
  | { kind: 'days'; anchor: string }
  | { kind: 'time'; day: string; anchor: number }
  | { kind: 'move'; r: Task; from: Hit }
  | { kind: 'first' | 'last' | 'end'; r: Task };

// Lo que saldría al soltar aquí.
function shapeFor(g: Grab, h: Hit): Shape | null {
  if (g.kind === 'days') {
    const [first, last] = [g.anchor, h.day].sort();
    return { first, last, startTime: null, endTime: null };
  }
  if (g.kind === 'time') {
    if (h.m === null) return null;
    let a = snap(g.anchor);
    let b = snap(h.m);
    if (b < a) [a, b] = [b, a];
    if (b - a < SNAP) b = a + 2 * SNAP;
    return shapeFrom(abs(g.day, a), abs(g.day, Math.min(1440, b)));
  }
  const s = shapeOf(g.r);
  if (g.kind === 'first') return { ...s, first: h.day < s.last ? h.day : s.last };
  if (g.kind === 'last') return { ...s, last: h.day > s.first ? h.day : s.first };
  if (g.kind === 'end') {
    if (h.m === null || !s.startTime) return null;
    const [a] = span(s);
    return shapeFrom(a, Math.max(a + SNAP, abs(h.day, snap(h.m))));
  }
  if (g.kind !== 'move') return null;
  // Mover: a una hora, con lo que dure; a un día, entera (a «todo el día», sin horas).
  if (h.zone === 'col') {
    if (s.startTime && g.from.zone === 'col') {
      const [a, b] = span(s);
      const d = snap(abs(h.day, h.m!) - abs(g.from.day, g.from.m!));
      return shapeFrom(a + d, b + d);
    }
    const dur = s.startTime ? Math.min(1440, span(s)[1] - span(s)[0]) : 60;
    const at = abs(h.day, Math.min(1440 - SNAP, Math.floor(h.m! / SNAP) * SNAP));
    return shapeFrom(at, at + dur);
  }
  const d = dayDiff(g.from.day, h.day);
  const moved = { ...s, first: shiftDay(s.first, d), last: shiftDay(s.last, d) };
  return h.zone === 'allday' ? { ...moved, startTime: null, endTime: null } : moved;
}

type Ctx = {
  p: CalProps;
  begin: (e: React.PointerEvent, g: Grab, now?: boolean) => void;
  busy: () => boolean;
  /** Lo que se está arrastrando o, si no, lo elegido. */
  preview: Shape | null;
  moving: string | null;
};

// Con el ratón, arrastrar empieza al moverse unos píxeles; con el dedo, al
// mantener pulsado (si se mueve antes, es que quería desplazarse). Los bordes
// para estirar responden al momento. Mientras dura, el dedo no desplaza nada.
function useGesture(p: CalProps): Ctx {
  const [live, setLive] = useState<{ g: Grab; s: Shape | null } | null>(null);
  const cur = useRef<{ stop: () => void } | null>(null);
  const pRef = useRef(p);
  pRef.current = p;
  useEffect(() => () => cur.current?.stop(), []);

  const begin = (e: React.PointerEvent, g: Grab, now = false) => {
    if (e.button !== 0 || cur.current) return;
    const touch = e.pointerType !== 'mouse';
    const id = e.pointerId;
    const st = { x: e.clientX, y: e.clientY, on: false, moved: false, timer: 0, s: null as Shape | null };
    const html = document.documentElement;
    const update = (x: number, y: number) => {
      const h = hitAt(x, y);
      const s = h && shapeFor(g, h);
      if (s) st.s = s;
      setLive({ g, s: st.s });
    };
    const activate = () => {
      st.on = true;
      html.classList.add('cal-gesture');
      if (touch) navigator.vibrate?.(8);
      update(st.x, st.y);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const far = Math.hypot(ev.clientX - st.x, ev.clientY - st.y) > (touch ? 8 : 4);
      if (!st.on) {
        if (!far) return;
        if (touch && !now) return stop();
        activate();
      }
      if (far) st.moved = true;
      update(ev.clientX, ev.clientY);
    };
    const holdStill = (ev: TouchEvent) => {
      if (st.on && ev.cancelable) ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const { on, moved, s } = st;
      stop();
      if (!on) return;
      // El clic que viene detrás de soltar no cuenta.
      const swallow = (c: Event) => {
        c.stopPropagation();
        c.preventDefault();
      };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 60);
      const q = pRef.current;
      // Mantener pulsada una tarea sin moverla abre su menú.
      if (g.kind === 'move' && !moved) return touch && q.onMenu(st.x, st.y, g.r);
      if (!s) return;
      if (g.kind === 'days') return (touch || s.first !== s.last) && q.onRange(s);
      if (g.kind === 'time') return q.onRange(s);
      const c = changeFor(g.r, s);
      if (Object.keys(c).length) q.onPlace(g.r, c);
    };
    const stop = () => {
      clearTimeout(st.timer);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', stop);
      removeEventListener('touchmove', holdStill);
      html.classList.remove('cal-gesture');
      cur.current = null;
      setLive(null);
    };
    cur.current = { stop };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', stop);
    addEventListener('touchmove', holdStill, { passive: false });
    if (now) activate();
    else if (touch) st.timer = window.setTimeout(activate, 420);
  };

  const g = live?.g;
  return {
    p,
    begin,
    busy: () => !!cur.current,
    preview: live ? live.s : p.range,
    moving: g && g.kind !== 'days' && g.kind !== 'time' ? g.r.id : null,
  };
}

// ── Piezas ────────────────────────────────────────────────────────────
type Grip = 'first' | 'last' | 'end';

// Una tarea: se señala con un clic, se abre con doble clic, se arrastra a otro
// día u hora y, por sus bordes, se estira. Las próximas veces de una que se
// repite salen en tenue: llevan a la de verdad y no se mueven.
function CalTask({ r, c, kind = 'item', where, label, style, contL, contR, grips = [] }: { r: CalItem; c: Ctx; kind?: 'item' | 'bar' | 'block'; where?: string; label?: string; style?: CSSProperties; contL?: boolean; contR?: boolean; grips?: Grip[] }) {
  const { p } = c;
  const real = r.of ?? r;
  const ghost = !!r.of;
  const late = !ghost && r.status !== 'done' && lastDay(r) < isoDay(0);
  return (
    <div
      className={`tv-cal-task is-${kind}${ghost ? ' is-ghost' : ''}${!ghost && r.status === 'done' ? ' is-done' : ''}${real.id === p.selected ? ' is-sel' : ''}${late ? ' is-late' : ''}${contL ? ' is-cont-l' : ''}${contR ? ' is-cont-r' : ''}${c.moving === r.id ? ' is-moving' : ''}`}
      style={style}
      title={ghost ? repeatLabel(real.repeat ?? '') : [titleOf(real), label].filter(Boolean).join(' · ')}
      onPointerDown={(e) => {
        e.stopPropagation();
        const from = hitAt(e.clientX, e.clientY);
        if (!ghost && from) c.begin(e, { kind: 'move', r, from });
      }}
      onClick={(e) => {
        e.stopPropagation();
        p.onSelect(real);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        p.onOpen(real);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!c.busy()) p.onMenu(e.clientX, e.clientY, real);
      }}
    >
      {ghost ? (
        <span className="tv-recur" aria-hidden="true">
          🔁
        </span>
      ) : (
        <Check row={r} onToggle={() => p.onToggle(r)} />
      )}
      {label && <time>{label}</time>}
      <span className="tv-cal-title">{titleOf(real)}</span>
      {where && <em className="tv-cal-where">{where}</em>}
      {!ghost &&
        grips.map((g) => (
          <i
            key={g}
            className={`tv-cal-grip is-${g}`}
            aria-hidden="true"
            onPointerDown={(e) => {
              e.stopPropagation();
              c.begin(e, { kind: g, r }, true);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ))}
    </div>
  );
}

// Un evento de un calendario de fuera: solo se mira, con el color de su calendario.
function CalEventItem({ e, p, where, kind, style }: { e: DayEvent; p: CalProps; where?: boolean; kind?: 'bar' | 'block'; style?: CSSProperties }) {
  const c = p.calendars.find((k) => k.id === e.cal);
  const span = e.allDay ? t('Todo el día') : `${TIME().format(new Date(e.start))}–${TIME().format(new Date(e.end))}`;
  const tip = [e.title, span, e.location, c?.name].filter(Boolean).join(' · ');
  return (
    <div className={`tv-cal-ev${e.allDay ? ' is-allday' : ''}${kind ? ` is-${kind}` : ''}`} style={{ '--ev': c?.color ?? 'var(--text-ghost)', ...style } as CSSProperties} title={tip}>
      <i aria-hidden="true" />
      {kind === 'block' ? <time>{span}</time> : e.time && <time>{e.time}</time>}
      <span>{e.title === '(sin título)' ? t('(sin título)') : e.title}</span>
      {where && c && <em className="tv-cal-where">{c.name}</em>}
    </div>
  );
}

export function TaskCalendar(p: CalProps) {
  const c = useGesture(p);
  if (p.mode === 'agenda') return <CalAgenda c={c} />;
  if (p.mode === 'mes') return <CalMonth c={c} />;
  return <CalColumns c={c} />;
}

// Mes en cuadrícula, de lunes a domingo. Lo de varios días, en barras que
// cruzan la semana; lo demás, en su día. El día elegido es donde se apunta.
function CalMonth({ c }: { c: Ctx }) {
  const { p } = c;
  const { month, day } = p;
  const today = isoDay(0);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;
  const items = useItems(p.tasks, days[0], addDays(days[weeks * 7 - 1], 1));
  const { bars, singles } = useMemo(() => {
    const singles = new Map<string, CalItem[]>();
    for (const r of items) if (!spans(r)) singles.set(lastDay(r), [...(singles.get(lastDay(r)) ?? []), r]);
    return { bars: items.filter(spans), singles };
  }, [items]);
  const pv = c.preview;

  return (
    <div className="tv-cal" style={{ '--weeks': weeks, '--bar': `${BAR}px` } as CSSProperties}>
      {DOW.map((d) => (
        <div key={d} className="tv-cal-dow">
          {t(d)}
        </div>
      ))}
      {Array.from({ length: weeks }, (_, w) => {
        const wk = days.slice(w * 7, w * 7 + 7);
        const laid = lanes(bars.filter((r) => firstDay(r) <= wk[6] && lastDay(r) >= wk[0]).map((r) => ({ it: r, s: Math.max(0, dayDiff(wk[0], firstDay(r))), e: Math.min(6, dayDiff(wk[0], lastDay(r))) })));
        const used = Math.min(MAX_LANES, laid.count);
        return (
          <div key={wk[0]} className="tv-cal-week">
            {wk.map((iso, k) => {
              const list = singles.get(iso) ?? [];
              const evs = p.events.get(iso) ?? [];
              const fits = Math.max(1, 4 - used);
              const evShown = evs.slice(0, Math.max(fits - list.length, Math.min(evs.length, 1)));
              const shown = list.slice(0, Math.max(0, fits - evShown.length));
              const hidden = list.length - shown.length + evs.length - evShown.length + laid.list.filter((g) => g.lane >= MAX_LANES && g.s <= k && g.e >= k).length;
              return (
                <div
                  key={iso}
                  data-day={iso}
                  className={`tv-cal-day${iso.slice(0, 7) !== month ? ' is-other' : ''}${iso === today ? ' is-today' : ''}${iso === day ? ' is-on' : ''}${pv && iso >= pv.first && iso <= pv.last ? ' is-range' : ''}`}
                  onClick={() => p.onDay(iso)}
                  onPointerDown={(e) => c.begin(e, { kind: 'days', anchor: iso })}
                >
                  <span className="tv-cal-num">{Number(iso.slice(8))}</span>
                  {used > 0 && <i className="tv-cal-lanes" style={{ height: used * (BAR + 2) - 2 }} />}
                  {evShown.map((e) => (
                    <CalEventItem key={e.cal + e.id} e={e} p={p} />
                  ))}
                  {shown.map((r) => (
                    <CalTask key={r.id} r={r} c={c} label={r.startTime ?? undefined} grips={['last']} />
                  ))}
                  {hidden > 0 && <span className="tv-cal-more">{t('+{n} más', { n: hidden })}</span>}
                </div>
              );
            })}
            {laid.list
              .filter((g) => g.lane < MAX_LANES)
              .map((g) => {
                const r = g.it;
                const opens = firstDay(r) >= wk[0];
                const closes = lastDay(r) <= wk[6];
                return (
                  <CalTask
                    key={r.id}
                    r={r}
                    c={c}
                    kind="bar"
                    label={opens && r.startTime ? r.startTime : undefined}
                    contL={!opens}
                    contR={!closes}
                    grips={[...(opens ? (['first'] as const) : []), ...(closes ? (['last'] as const) : [])]}
                    style={{ left: `calc(${g.s} * 100% / 7 + 3px)`, width: `calc(${g.e - g.s + 1} * 100% / 7 - 6px)`, top: 28 + g.lane * (BAR + 2) }}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

// Día, 3 días y semana: arriba lo de todo el día (en barras si dura varios) y,
// debajo, las horas, con cada tarea con hora como un bloque.
function CalColumns({ c }: { c: Ctx }) {
  const { p } = c;
  const today = isoDay(0);
  const n = p.days.length;
  const from = p.days[0];
  const last = p.days[n - 1];
  const items = useItems(p.tasks, from, addDays(last, 1));
  const roomy = p.mode !== 'semana';

  type It = { task: CalItem } | { ev: DayEvent };
  const top = useMemo(() => {
    const segs: { it: It; s: number; e: number }[] = [];
    // Los eventos de día completo de varios días van en una sola barra.
    const evs = new Map<string, { it: It; s: number; e: number }>();
    p.days.forEach((iso, k) =>
      (p.events.get(iso) ?? [])
        .filter((e) => e.allDay)
        .forEach((e) => {
          const key = `${e.cal}\u0000${e.id}\u0000${e.start}`;
          const g = evs.get(key);
          if (g) g.e = k;
          else evs.set(key, { it: { ev: e }, s: k, e: k });
        }),
    );
    segs.push(...evs.values());
    for (const r of items) if (!r.startTime && firstDay(r) <= last && lastDay(r) >= from) segs.push({ it: { task: r }, s: Math.max(0, dayDiff(from, firstDay(r))), e: Math.min(n - 1, dayDiff(from, lastDay(r))) });
    return lanes(segs);
  }, [items, p.events, p.days, from, last, n]);

  const timed = useMemo(() => {
    const per = new Map<string, { it: It; a: number; b: number }[]>();
    const put = (iso: string, it: It, a: number, b: number) => b > a && per.set(iso, [...(per.get(iso) ?? []), { it, a, b: Math.max(b, a + 20) }]);
    for (const r of items) {
      if (!r.startTime) continue;
      const [A, B] = span(shapeOf(r));
      for (const iso of p.days) {
        const d0 = abs(iso, 0);
        put(iso, { task: r }, Math.max(A, d0) - d0, Math.min(B, d0 + 1440) - d0);
      }
    }
    for (const iso of p.days)
      for (const e of p.events.get(iso) ?? []) {
        if (e.allDay) continue;
        const s = new Date(e.start);
        const en = new Date(e.end);
        const a = isoOf(s) === iso ? s.getHours() * 60 + s.getMinutes() : 0;
        const b = isoOf(new Date(en.getTime() - 1)) === iso ? en.getHours() * 60 + en.getMinutes() || 1440 : 1440;
        put(iso, { ev: e }, a, Math.max(b, a + SNAP));
      }
    return new Map([...per].map(([k, v]) => [k, columns(v)]));
  }, [items, p.events, p.days]);

  // Al abrir, las horas empiezan por la mañana (o por lo primero que haya antes).
  const scroller = useRef<HTMLDivElement>(null);
  const earliest = Math.min(7 * 60, ...[...timed.values()].flat().filter((b) => b.a > 0).map((b) => b.a));
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (earliest - 30) / 60) * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mode, from]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowM = now.getHours() * 60 + now.getMinutes();

  const pv = c.preview;
  const pvDays = pv && !pv.startTime ? pv : null;
  const pvTime = pv?.startTime ? span(pv) : null;
  const rows = Math.max(1, top.count);
  const blockStyle = (b: { a: number; b: number; col: number; cols: number }): CSSProperties => ({
    top: (b.a / 60) * HOUR,
    height: ((b.b - b.a) / 60) * HOUR - 2,
    left: `calc(${b.col} * 100% / ${b.cols} + 1px)`,
    width: `calc(100% / ${b.cols} - 4px)`,
  });

  return (
    <div className={`tv-cal-cols is-${p.mode}`} ref={scroller} style={{ '--cols': n, '--hour': `${HOUR}px` } as CSSProperties}>
      <div className="tv-cal-top">
        <span className="tv-cal-gut" />
        {p.days.map((iso) => (
          <button key={iso} className={`tv-cal-colhead${iso === today ? ' is-today' : ''}${iso === p.day ? ' is-on' : ''}`} onClick={() => p.onDay(iso)}>
            <span className="tv-cal-coldow">{SHORT_DOW().format(dateOf(iso)).replace('.', '')}</span>
            <span className="tv-cal-num">{Number(iso.slice(8))}</span>
          </button>
        ))}
        <span className="tv-cal-gut tv-cal-gut-day">{roomy ? t('Todo el día') : ''}</span>
        <div className="tv-cal-allday" style={{ gridTemplateRows: `repeat(${rows}, auto)` }}>
          {p.days.map((iso, k) => (
            <div
              key={iso}
              data-day={iso}
              data-allday=""
              className={`tv-cal-allcell${iso === p.day ? ' is-on' : ''}${pvDays && iso >= pvDays.first && iso <= pvDays.last ? ' is-range' : ''}`}
              style={{ gridColumn: k + 1, gridRow: `1 / ${rows + 1}` }}
              onClick={() => p.onDay(iso)}
              onPointerDown={(e) => c.begin(e, { kind: 'days', anchor: iso })}
            />
          ))}
          {top.list.map((g) => {
            const style = { gridColumn: `${g.s + 1} / ${g.e + 2}`, gridRow: g.lane + 1 };
            if ('ev' in g.it) return <CalEventItem key={`${g.it.ev.cal}${g.it.ev.id}${g.it.ev.start}`} e={g.it.ev} p={p} kind="bar" style={style} />;
            const r = g.it.task;
            const opens = firstDay(r) >= from;
            const closes = lastDay(r) <= last;
            return (
              <CalTask
                key={r.id}
                r={r}
                c={c}
                kind="bar"
                style={style}
                contL={!opens}
                contR={!closes}
                where={roomy && g.s === g.e ? p.whereOf(r) : undefined}
                grips={[...(opens ? (['first'] as const) : []), ...(closes ? (['last'] as const) : [])]}
              />
            );
          })}
        </div>
      </div>
      <div className="tv-cal-hours">
        <div className="tv-cal-ticks" aria-hidden="true">
          {Array.from({ length: 23 }, (_, h) => (
            <span key={h} style={{ top: (h + 1) * HOUR }}>
              {hhmm((h + 1) * 60)}
            </span>
          ))}
        </div>
        {p.days.map((iso) => {
          const d0 = abs(iso, 0);
          const pa = pvTime && Math.max(pvTime[0], d0) - d0;
          const pb = pvTime && Math.min(pvTime[1], d0 + 1440) - d0;
          return (
            <div
              key={iso}
              data-col={iso}
              className={`tv-cal-col${iso === p.day ? ' is-on' : ''}${iso < today ? ' is-past' : ''}`}
              onClick={() => p.onDay(iso)}
              onPointerDown={(e) => {
                const h = hitAt(e.clientX, e.clientY);
                if (h?.m != null) c.begin(e, { kind: 'time', day: iso, anchor: h.m });
              }}
            >
              {(timed.get(iso) ?? []).map((b) => {
                if ('ev' in b.it) return <CalEventItem key={`${b.it.ev.cal}${b.it.ev.id}${b.it.ev.start}`} e={b.it.ev} p={p} kind="block" style={blockStyle(b)} />;
                const r = b.it.task;
                return <CalTask key={r.id} r={r} c={c} kind="block" style={blockStyle(b)} label={timeLabel(r)} where={roomy ? p.whereOf(r) : undefined} grips={lastDay(r) === iso ? ['end'] : []} />;
              })}
              {pa !== null && pb !== null && pb > pa && (
                <div className="tv-cal-pv" style={{ top: (pa / 60) * HOUR, height: ((pb - pa) / 60) * HOUR - 2 }}>
                  {pv && timeLabel(pv)}
                </div>
              )}
              {iso === today && <i className="tv-cal-now" style={{ top: (nowM / 60) * HOUR }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Agenda: lo que viene, día a día, solo los días con algo (lo de varios días,
// en cada uno). Si empieza hoy (o antes), arriba van las pendientes que ya vencieron.
function CalAgenda({ c }: { c: Ctx }) {
  const { p } = c;
  const today = isoDay(0);
  const end = addDays(p.day, 60);
  // Las próximas veces de lo que se repite, en los dos meses siguientes.
  const items = useItems(p.tasks, p.day, end);
  const byDay = useMemo(() => {
    const out = new Map<string, CalItem[]>();
    const add = (iso: string, r: CalItem) => out.set(iso, [...(out.get(iso) ?? []), r]);
    for (const r of items) {
      const f = firstDay(r);
      const l = lastDay(r);
      if (l < p.day) add(l, r);
      else for (let d = f < p.day ? p.day : f, k = 0; d <= l && d < end && k < 400; d = addDays(d, 1), k++) add(d, r);
    }
    return out;
  }, [items, p.day, end]);
  const late = p.day <= today ? items.filter((r) => !r.of && r.status !== 'done' && lastDay(r) < p.day) : [];
  const days = [...new Set([...byDay.keys(), ...p.events.keys()])].filter((iso) => iso >= p.day).sort();
  if (!days.includes(p.day)) days.unshift(p.day);
  const label = (iso: string) => {
    const n = daysUntil(iso);
    return n === 0 ? t('Hoy') : n === 1 ? t('Mañana') : n === -1 ? t('Ayer') : cap(SHORT_DOW().format(dateOf(iso)).replace('.', ''));
  };
  const range = (r: Task) => (spans(r) ? `${SHORT_DAY().format(dateOf(firstDay(r)))} – ${SHORT_DAY().format(dateOf(lastDay(r)))}` : '');
  // Lo que dura varios días con horas: el primero, desde cuándo; el último, hasta cuándo.
  const hours = (r: Task, iso: string) =>
    !spans(r) || !r.startTime ? timeLabel(r) || undefined : iso === firstDay(r) ? r.startTime : iso === lastDay(r) && r.endTime ? `→ ${r.endTime}` : undefined;
  const where = (r: Task, ...pre: string[]) => [...pre, range(r), p.whereOf(r)].filter(Boolean).join(' · ');
  const pv = c.preview;
  return (
    <div className="tv-agenda">
      {late.length > 0 && (
        <section className="tv-agenda-day is-late">
          <div className="tv-agenda-date">
            <span className="tv-agenda-dow">{t('Vencidas')}</span>
          </div>
          <div className="tv-agenda-list">
            {late.map((r) => (
              <CalTask key={r.id} r={r} c={c} label={hours(r, lastDay(r))} where={where(r, dueLabel(lastDay(r)))} />
            ))}
          </div>
        </section>
      )}
      {days.map((iso) => {
        const list = byDay.get(iso) ?? [];
        return (
          <section key={iso} data-day={iso} className={`tv-agenda-day${iso === today ? ' is-today' : ''}${iso === p.day ? ' is-on' : ''}${pv && c.moving && iso >= pv.first && iso <= pv.last ? ' is-over' : ''}`}>
            <button className="tv-agenda-date" onClick={() => p.onDay(iso)} title={t('Apuntar en este día')}>
              <span className="tv-cal-num">{Number(iso.slice(8))}</span>
              <span className="tv-agenda-dow">
                {label(iso)}
                <span className="tv-agenda-month">{MONTH_NAME().format(dateOf(iso))}</span>
              </span>
            </button>
            <div className="tv-agenda-list">
              {(p.events.get(iso) ?? []).map((e) => (
                <CalEventItem key={e.cal + e.id} e={e} p={p} where />
              ))}
              {list.map((r) => (
                <CalTask key={r.id} r={r} c={c} label={hours(r, iso)} where={where(r)} />
              ))}
              {!list.length && !p.events.get(iso)?.length && <p className="tv-cal-empty">{t('Nada este día.')}</p>}
            </div>
          </section>
        );
      })}
      {days.length === 1 && !byDay.get(p.day)?.length && !p.events.get(p.day)?.length && <p className="tv-cal-empty tv-agenda-end">{t('No hay nada con fecha a partir de aquí.')}</p>}
    </div>
  );
}
