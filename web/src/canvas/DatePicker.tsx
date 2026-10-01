import { useState, type CSSProperties } from 'react';
import { daysUntil, dueLabel } from './dates';

// Selector de fecha propio, en vez del calendario nativo del navegador: un
// botón que abre un mes en cuadrícula, con mes anterior/siguiente y «Hoy».

const DOW = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MONTH = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

type Props = {
  value: string | null;
  onChange: (v: string | null) => void;
  className?: string;
  label?: string;
  placeholder?: string;
};

export function DatePicker({ value, onChange, className, label = 'Fecha', placeholder = 'Fecha' }: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => (value ?? isoOf(new Date())).slice(0, 7));

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };
  const openAt = () => {
    setMonth((value ?? isoOf(new Date())).slice(0, 7));
    setOpen(true);
  };

  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
  const today = isoOf(new Date());
  const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;
  const shiftMonth = (n: number) => setMonth(isoOf(new Date(y, m - 1 + n, 1)).slice(0, 7));

  return (
    <>
      <button type="button" className={className} aria-label={label} onClick={openAt}>
        {value ? cap(dueLabel(value)) : <span className="dp-placeholder">{placeholder}</span>}
      </button>
      {open && (
        <div className="overlay dp-overlay" onMouseDown={() => setOpen(false)}>
          <div className="surface-3 popover dp-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dp-head">
              <button type="button" className="dp-nav" aria-label="Mes anterior" onClick={() => shiftMonth(-1)}>
                ‹
              </button>
              <span className="dp-month">{cap(MONTH.format(dateOf(`${month}-01`)))}</span>
              <button type="button" className="dp-nav" aria-label="Mes siguiente" onClick={() => shiftMonth(1)}>
                ›
              </button>
            </div>
            <div className="dp-grid" style={{ '--weeks': weeks } as CSSProperties}>
              {DOW.map((d) => (
                <span key={d} className="dp-dow">
                  {d}
                </span>
              ))}
              {days.slice(0, weeks * 7).map((iso) => (
                <button
                  type="button"
                  key={iso}
                  className={`dp-day${iso.slice(0, 7) !== month ? ' is-other' : ''}${iso === today ? ' is-today' : ''}${iso === value ? ' is-on' : ''}${
                    value && iso !== value && daysUntil(iso) < 0 ? ' is-past' : ''
                  }`}
                  onClick={() => pick(iso)}
                >
                  {Number(iso.slice(8))}
                </button>
              ))}
            </div>
            <div className="dp-foot">
              <button type="button" className="dp-today" onClick={() => pick(today)}>
                Hoy
              </button>
              {value && (
                <button type="button" className="dp-clear" onClick={() => onChange(null)}>
                  Quitar fecha
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
