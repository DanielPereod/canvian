import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Desplegables y calendario propios, en lugar de los del navegador: se ven
// igual en todos los sistemas y siguen el tema y la tipografía de Canvian.

// ── Capa flotante ─────────────────────────────────────────

// Se pega debajo del botón que la abre (o encima si no cabe) y se cierra al
// pulsar fuera, con Escape o al desplazar la página.
function Floating({ anchor, onClose, children, className, label }: { anchor: HTMLElement; onClose: () => void; children: ReactNode; className: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: -9999, top: 0 });
  // Fuera de la pantalla hasta medirla, no oculta: así el calendario puede
  // llevarse el foco nada más abrirse.

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
      const below = a.bottom + 6 + h <= window.innerHeight - 8 || a.top - 6 - h < 8;
      setPos({ left, top: below ? a.bottom + 6 : a.top - 6 - h, minWidth: Math.max(a.width, 180), transformOrigin: below ? 'top left' : 'bottom left' });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className={`pick-pop ${className}`} style={pos} role="dialog" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}

const Chevron = () => (
  <svg className="pick-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ── Desplegable ───────────────────────────────────────────

export type SelectOption = { value: string; label: string; style?: CSSProperties };
export type SelectGroup = { label?: string; options: SelectOption[] };

export function Select({ value, onChange, groups, className = '', label }: { value: string; onChange: (v: string) => void; groups: SelectGroup[]; className?: string; label?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const current = flat.find((o) => o.value === value);
  const [cursor, setCursor] = useState(0);

  const show = () => {
    setCursor(Math.max(0, flat.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  const pick = (o: SelectOption) => {
    if (o.value !== value) onChange(o.value);
    close();
  };

  // La opción activa siempre a la vista.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  const keys = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const move = (n: number) => setCursor((c) => Math.max(0, Math.min(flat.length - 1, n === Infinity ? flat.length - 1 : n === -Infinity ? 0 : c + n)));
    const map: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      PageDown: () => move(8),
      PageUp: () => move(-8),
      Home: () => move(-Infinity),
      End: () => move(Infinity),
      Enter: () => flat[cursor] && pick(flat[cursor]),
      ' ': () => flat[cursor] && pick(flat[cursor]),
      Escape: close,
      Tab: () => setOpen(false),
    };
    const run = map[e.key];
    if (run) {
      if (e.key !== 'Tab') e.preventDefault();
      run();
    }
  };

  let i = -1;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`pick-trigger ${className}${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keys}
      >
        <span className="pick-value" style={current?.style}>
          {current?.label ?? '—'}
        </span>
        <Chevron />
      </button>
      {open && btn.current && (
        <Floating anchor={btn.current} onClose={() => setOpen(false)} className="pick-menu" label={label}>
          <div ref={list} role="listbox" aria-label={label} className="pick-list" onKeyDown={keys}>
            {groups.map((g, gi) => (
              <div key={gi} role="group" aria-label={g.label}>
                {g.label && <div className="pick-group">{g.label}</div>}
                {g.options.map((o) => {
                  i++;
                  const at = i;
                  return (
                    <div
                      key={o.value}
                      data-i={at}
                      role="option"
                      aria-selected={o.value === value}
                      className={`pick-opt${at === cursor ? ' is-cursor' : ''}`}
                      style={o.style}
                      onPointerMove={() => setCursor(at)}
                      onClick={() => pick(o)}
                    >
                      <span>{o.label}</span>
                      {o.value === value && (
                        <svg className="pick-tick" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2.5 6.2l2.4 2.3 4.6-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Floating>
      )}
    </>
  );
}

// ── Calendario ────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};
const MONTH = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const LONG = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const SHORT = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
const WEEK = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

export function DatePicker({
  value,
  onChange,
  className = '',
  label = 'Fecha',
  placeholder = 'Sin fecha',
  format,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  className?: string;
  label?: string;
  placeholder?: string;
  // Cómo se escribe la fecha en el botón; por defecto «3 oct 2026».
  format?: (v: string) => string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const shown = value ? (format ? format(value) : SHORT.format(parse(value)).replace('.', '')) : placeholder;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`pick-trigger pick-date ${className}${open ? ' is-open' : ''}${value ? '' : ' is-empty'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${label}: ${LONG.format(parse(value))}` : label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg className="pick-cal-icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.75" y="2.75" width="10.5" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M1.75 5.75h10.5M4.75 1.5v2.5M9.25 1.5v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="pick-value">{shown}</span>
      </button>
      {open && btn.current && (
        <Floating anchor={btn.current} onClose={() => setOpen(false)} className="pick-cal" label={label}>
          <Calendar
            value={value}
            onPick={(v) => {
              if (v !== value) onChange(v);
              setOpen(false);
              btn.current?.focus();
            }}
            onClose={() => {
              setOpen(false);
              btn.current?.focus();
            }}
          />
        </Floating>
      )}
    </>
  );
}

function Calendar({ value, onPick, onClose }: { value: string | null; onPick: (v: string | null) => void; onClose: () => void }) {
  const today = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);
  const [focus, setFocus] = useState(() => (value ? parse(value) : today));
  const grid = useRef<HTMLDivElement>(null);

  // Seis semanas desde el lunes de la semana del día 1.
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));

  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-d="${iso(focus)}"]`)?.focus();
  }, [focus]);

  const keys = (e: React.KeyboardEvent) => {
    const map: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -((focus.getDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() + 6) % 7)),
    };
    if (map[e.key]) {
      e.preventDefault();
      setFocus(map[e.key]());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const sel = value?.slice(0, 10);
  return (
    <div className="cal" onKeyDown={keys}>
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label="Mes anterior" onClick={() => setFocus(addMonths(focus, -1))}>
          ‹
        </button>
        <span className="cal-month" aria-live="polite">
          {MONTH.format(focus).replace(/^./, (c) => c.toUpperCase())}
        </span>
        <button type="button" className="cal-nav" aria-label="Mes siguiente" onClick={() => setFocus(addMonths(focus, 1))}>
          ›
        </button>
      </div>
      <div className="cal-grid" role="grid" ref={grid}>
        {WEEK.map((w) => (
          <span key={w} className="cal-wd" aria-hidden="true">
            {w}
          </span>
        ))}
        {days.map((d) => {
          const k = iso(d);
          const out = d.getMonth() !== focus.getMonth();
          const isFocus = k === iso(focus);
          return (
            <button
              key={k}
              type="button"
              data-d={k}
              tabIndex={isFocus ? 0 : -1}
              aria-label={LONG.format(d)}
              aria-pressed={k === sel}
              className={`cal-day${out ? ' is-out' : ''}${k === sel ? ' is-sel' : ''}${k === iso(today) ? ' is-today' : ''}${d.getDay() === 0 || d.getDay() === 6 ? ' is-weekend' : ''}`}
              onClick={() => onPick(k)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="cal-foot">
        <button type="button" onClick={() => onPick(iso(today))}>
          Hoy
        </button>
        <button type="button" onClick={() => onPick(iso(addDays(today, 1)))}>
          Mañana
        </button>
        <button type="button" onClick={() => onPick(iso(addDays(today, 7 - ((today.getDay() + 6) % 7))))}>
          Próx. lunes
        </button>
        {value && (
          <button type="button" className="cal-clear" onClick={() => onPick(null)}>
            Quitar
          </button>
        )}
      </div>
    </div>
  );
}
