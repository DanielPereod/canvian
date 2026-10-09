import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { NoteRow, PropValue } from '../api';
import { locale, t, tn } from '../i18n';
import { hueOf, titleOf } from './Biblioteca';
import { TOUCH } from './touch';
import { datable, valueOf, type Field, type View, type Zoom } from './views';

// La línea de tiempo de una colección, como la de Notion: cada nota es una
// barra entre la fecha en que empieza y la fecha en que acaba (o un punto si
// solo tiene una). Se acerca por días, semanas o meses, la raya de hoy marca
// dónde estás y las barras se arrastran para moverlas o se estiran por los
// bordes para cambiar el principio o el final.

type Props = {
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

// Píxeles por día de cada zoom.
const PX: Record<Zoom, number> = { day: 36, week: 14, month: 4 };
const ZOOMS: { id: Zoom; name: string }[] = [
  { id: 'day', name: 'Día' },
  { id: 'week', name: 'Semana' },
  { id: 'month', name: 'Mes' },
];
const DAY = 86_400_000;

// Los días se cuentan en UTC para que un cambio de hora no descuadre nada.
const dayNum = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return y && m && d ? Math.round(Date.UTC(y, m - 1, d) / DAY) : null;
};
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const dateOf = (n: number) => new Date(n * DAY);
const todayNum = () => {
  const d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

type Span = { r: NoteRow; start: number; end: number; ranged: boolean };
type Drag = { id: string; mode: 'move' | 'start' | 'end'; x: number; delta: number; moved: boolean };

const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (o: Intl.DateTimeFormatOptions) => {
  const k = `${locale()}:${JSON.stringify(o)}`;
  let f = fmts.get(k);
  if (!f) fmts.set(k, (f = new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', ...o })));
  return f;
};
const cap = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const label = (n: number) => fmt({ day: 'numeric', month: 'short' }).format(dateOf(n)).replace(/\.(?=\s|$)/g, '');

export function Timeline(p: Props) {
  const startF = p.fields.find((x) => x.id === p.view.date && datable(x)) ?? p.fields.find((x) => x.id === 'due')!;
  const endF = p.fields.find((x) => x.id === p.view.end && datable(x) && x.id !== startF.id) ?? null;
  const zoom: Zoom = p.view.zoom ?? 'week';
  const px = PX[zoom];
  const today = todayNum();
  const [drag, setDrag] = useState<Drag | null>(null);
  // Soltar una barra arrastrada no la abre.
  const dragged = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  // «Editada» va en UTC; se pinta en el día de aquí.
  const dayOf = (r: NoteRow, f: Field) => {
    const v = valueOf(r, f, p.count);
    if (typeof v !== 'string' || !v) return null;
    if (f.id === 'updated') {
      const d = new Date(Date.parse(v));
      return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
    }
    return dayNum(v);
  };

  const { spans, undated } = useMemo(() => {
    const spans: Span[] = [];
    const undated: NoteRow[] = [];
    for (const r of p.items) {
      let s = dayOf(r, startF);
      let e = endF ? dayOf(r, endF) : null;
      if (s === null && e === null) {
        undated.push(r);
        continue;
      }
      if (s === null) s = e!;
      if (e === null || e < s) e = s;
      spans.push({ r, start: s, end: e, ranged: !!endF });
    }
    // Sin orden propio, por la fecha en que empiezan.
    if (!p.view.sorts.length) spans.sort((a, b) => a.start - b.start || a.end - b.end);
    return { spans, undated };
  }, [p.items, startF, endF, p.count, p.view.sorts.length]);

  // El tramo que se pinta: lo que ocupan las notas y hoy, con aire a los lados,
  // empezando en lunes (o en día 1 si va por meses).
  const [from, to] = useMemo(() => {
    let lo = today - 30;
    let hi = today + 90;
    for (const s of spans) {
      lo = Math.min(lo, s.start - 14);
      hi = Math.max(hi, s.end + 30);
    }
    // Ni años de barras vacías por una fecha mal puesta.
    lo = Math.max(lo, today - 365 * 3);
    hi = Math.min(hi, today + 365 * 3);
    const d = dateOf(lo);
    if (zoom === 'month') lo = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY);
    else lo -= (d.getUTCDay() + 6) % 7;
    return [lo, hi + (zoom === 'day' ? 14 : zoom === 'week' ? 60 : 200)];
  }, [spans, today, zoom]);
  const width = (to - from + 1) * px;
  const x = (n: number) => (n - from) * px;

  // Al abrir o cambiar de zoom, hoy queda a un cuarto del borde.
  const goToday = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: Math.max(0, x(today) - el.clientWidth / 4), behavior: smooth ? 'smooth' : 'auto' });
  };
  useLayoutEffect(() => goToday(), [zoom, p.view.id]);
  const page = (dir: number) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  // Las marcas de arriba y las rayas de fondo: días, lunes o primeros de mes.
  const { top, ticks, weekends } = useMemo(() => {
    const top: { n: number; text: string }[] = [];
    const ticks: { n: number; text: string; strong?: boolean }[] = [];
    const weekends: number[] = [];
    for (let n = from; n <= to; n++) {
      const d = dateOf(n);
      const first = d.getUTCDate() === 1;
      if (zoom === 'month') {
        if (first && d.getUTCMonth() === 0) top.push({ n, text: String(d.getUTCFullYear()) });
        if (first) ticks.push({ n, text: fmt({ month: 'short' }).format(d).replace(/\.$/, '') });
      } else {
        if (first || n === from) top.push({ n, text: cap(fmt({ month: 'long', year: 'numeric' }).format(d)) });
        const wd = d.getUTCDay();
        if (zoom === 'day') {
          ticks.push({ n, text: String(d.getUTCDate()), strong: wd === 1 });
          if (wd === 0 || wd === 6) weekends.push(n);
        } else if (wd === 1) ticks.push({ n, text: String(d.getUTCDate()) });
      }
    }
    if (zoom === 'month' && !top.length) top.push({ n: from, text: String(dateOf(from).getUTCFullYear()) });
    return { top, ticks, weekends };
  }, [from, to, zoom]);

  // Arrastrar: la barra entera mueve las dos fechas; los bordes, solo una.
  const movable = startF.editable && !TOUCH;
  const resizable = movable && !!endF?.editable;
  const shiftDay = (r: NoteRow, f: Field, n: number) => {
    // Lo que va detrás del día (una hora) se queda como estaba.
    const old = valueOf(r, f, p.count);
    p.onSet(r, f, isoOf(n) + (typeof old === 'string' && f.id !== 'updated' ? old.slice(10) : ''));
  };
  const begin = (e: React.PointerEvent, s: Span, mode: Drag['mode']) => {
    if (e.button !== 0 || (mode === 'move' ? !movable : !resizable)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: s.r.id, mode, x: e.clientX, delta: 0, moved: false });
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const delta = Math.round(dx / px);
    if (delta !== drag.delta || (!drag.moved && Math.abs(dx) > 3)) setDrag({ ...drag, delta, moved: drag.moved || Math.abs(dx) > 3 });
  };
  const endDrag = (s: Span) => {
    if (!drag) return;
    setDrag(null);
    const { mode, delta } = drag;
    if (drag.moved) {
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
    }
    if (!delta) return;
    const hasEnd = !!endF && valueOf(s.r, endF, p.count);
    if (mode === 'move') {
      shiftDay(s.r, startF, s.start + delta);
      if (endF && hasEnd && endF.editable) shiftDay(s.r, endF, s.end + delta);
    } else if (mode === 'start') shiftDay(s.r, startF, Math.min(s.start + delta, s.end));
    else if (endF) shiftDay(s.r, endF, Math.max(s.end + delta, s.start));
  };
  const live = (s: Span) => {
    if (drag?.id !== s.r.id) return s;
    if (drag.mode === 'move') return { ...s, start: s.start + drag.delta, end: s.end + drag.delta };
    if (drag.mode === 'start') return { ...s, start: Math.min(s.start + drag.delta, s.end) };
    return { ...s, end: Math.max(s.end + drag.delta, s.start) };
  };

  // Una nota sin fecha toma la del día en que se pulsa su fila.
  const place = (e: React.MouseEvent<HTMLDivElement>, r: NoteRow) => {
    if (!startF.editable) return;
    const box = e.currentTarget.getBoundingClientRect();
    p.onSet(r, startF, isoOf(from + Math.floor((e.clientX - box.left) / px)));
  };

  const rows: (Span | NoteRow)[] = [...spans, ...undated];
  const zoomName = (z: Zoom) => t(ZOOMS.find((o) => o.id === z)!.name);

  return (
    <div className="cv-tl" ref={p.listRef}>
      <div className="cv-cal-head">
        <span className="cv-tl-seg" role="radiogroup" aria-label={t('Zoom')}>
          {ZOOMS.map((z) => (
            <button key={z.id} role="radio" aria-checked={zoom === z.id} className={zoom === z.id ? 'is-on' : ''} onClick={() => p.onView({ ...p.view, zoom: z.id })}>
              {zoomName(z.id)}
            </button>
          ))}
        </span>
        <span className="bib-muted bib-small cv-tl-what">
          {endF ? t('De «{start}» a «{end}»', { start: startF.name, end: endF.name }) : startF.name}
          {undated.length > 0 && ` · ${tn(undated.length, '{n} sin fecha', '{n} sin fecha')}`}
        </span>
        <span className="cv-cal-nav">
          <button onClick={() => page(-1)} aria-label={t('Antes')}>
            ‹
          </button>
          <button onClick={() => goToday(true)}>{t('Hoy')}</button>
          <button onClick={() => page(1)} aria-label={t('Después')}>
            ›
          </button>
        </span>
      </div>
      <div className={`cv-tl-frame is-${zoom}${drag?.moved ? ' is-dragging' : ''}`}>
        <div className="cv-tl-names">
          <div className="cv-tl-corner" />
          {rows.map((it) => {
            const r = 'r' in it ? it.r : it;
            return (
              <button
                key={r.id}
                className={`cv-tl-name${p.sel === r.id ? ' is-sel' : ''}${p.dim(r) ? ' is-dim' : ''}`}
                style={{ '--h': hueOf(r.id) } as CSSProperties}
                onClick={() => p.onEnter(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onMenu(r.id, e.clientX, e.clientY);
                }}
              >
                <span className="bib-ellipsis">{titleOf(r)}</span>
              </button>
            );
          })}
        </div>
        <div className="cv-tl-scroll" ref={scroller}>
          <div className="cv-tl-track" style={{ width }}>
            <div className="cv-tl-top">
              {/* Cada mes (o año) ocupa su tramo y su nombre se queda a la vista al desplazar. */}
              {top.map((m, i) => (
                <span key={m.n} className="cv-tl-month" style={{ left: x(m.n), width: x(top[i + 1]?.n ?? to + 1) - x(m.n) }}>
                  <span>{m.text}</span>
                </span>
              ))}
            </div>
            <div className="cv-tl-ticks">
              {ticks.map((k) => (
                <span key={k.n} className={`cv-tl-tick${k.n === today ? ' is-today' : ''}`} style={{ left: x(k.n), width: zoom === 'day' ? px : undefined }}>
                  {k.text}
                </span>
              ))}
            </div>
            <div className="cv-tl-body" style={{ height: rows.length * 36 }}>
              {weekends.map((n) => (
                <span key={n} className="cv-tl-weekend" style={{ left: x(n), width: px }} />
              ))}
              {ticks.map((k) => (
                <span key={k.n} className="cv-tl-line" style={{ left: x(k.n) }} />
              ))}
              {today >= from && today <= to && <span className="cv-tl-today" style={{ left: x(today) + px / 2 }} title={t('Hoy')} />}
              {rows.map((it, i) => {
                if (!('r' in it))
                  return <div key={it.id} className={`cv-tl-row is-empty${startF.editable ? ' is-placeable' : ''}`} style={{ top: i * 36 }} title={startF.editable ? t('Pulsa para ponerle fecha') : undefined} onClick={(e) => place(e, it)} />;
                const s = live(it);
                const point = !s.ranged;
                const left = x(s.start);
                const w = (s.end - s.start + 1) * px;
                const roomy = !point && w >= 90;
                const text = s.end > s.start ? `${label(s.start)} → ${label(s.end)}` : label(s.start);
                return (
                  <div key={s.r.id} className="cv-tl-row" style={{ top: i * 36 }}>
                    <div
                      className={`cv-tl-bar${point ? ' is-point' : ''}${p.sel === s.r.id ? ' is-sel' : ''}${p.dim(s.r) ? ' is-dim' : ''}${movable ? ' is-movable' : ''}`}
                      style={{ left: point ? left + px / 2 : left, width: point ? undefined : w, '--h': hueOf(s.r.id) } as CSSProperties}
                      title={`${titleOf(s.r)} · ${text}`}
                      role="button"
                      tabIndex={-1}
                      onPointerDown={(e) => begin(e, it, 'move')}
                      onPointerMove={moveDrag}
                      onPointerUp={() => endDrag(it)}
                      onPointerCancel={() => setDrag(null)}
                      onClick={() => {
                        if (!dragged.current) p.onEnter(s.r);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        p.onMenu(s.r.id, e.clientX, e.clientY);
                      }}
                    >
                      {!point && resizable && <span className="cv-tl-grip is-start" onPointerDown={(e) => begin(e, it, 'start')} onPointerMove={moveDrag} onPointerUp={() => endDrag(it)} />}
                      {roomy && <span className="cv-tl-bar-t">{titleOf(s.r)}</span>}
                      {!point && resizable && <span className="cv-tl-grip is-end" onPointerDown={(e) => begin(e, it, 'end')} onPointerMove={moveDrag} onPointerUp={() => endDrag(it)} />}
                    </div>
                    {/* Fuera de la barra, el título si no cabe y siempre las fechas. */}
                    <span className="cv-tl-label" style={{ left: point ? left + px / 2 + 12 : left + Math.max(w, 6) + 8 }}>
                      {!roomy && <span className="cv-tl-label-t">{titleOf(s.r)}</span>}
                      <span className="bib-muted">{text}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
