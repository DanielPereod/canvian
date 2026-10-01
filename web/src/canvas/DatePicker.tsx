import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { dateFmt, daysUntil, dueLabel } from './dates';
import { t } from '../i18n';

// Selector de fecha propio, en vez del calendario nativo del navegador: un
// botón que abre un mes en cuadrícula, con mes anterior/siguiente, atajos
// (Hoy, Mañana, Próximo lunes) y se maneja también con el teclado.

// Iniciales de lunes a domingo, en el idioma de la interfaz (L M X J V S D).
const dows = () => Array.from({ length: 7 }, (_, k) => dateFmt({ weekday: 'narrow' }).format(new Date(2024, 0, 1 + k)));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso: string, n: number) => {
  const d = dateOf(iso);
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
// El lunes que viene: si hoy ya es lunes, el de la semana siguiente.
const nextMonday = (iso: string) => addDays(iso, ((1 - dateOf(iso).getDay() + 7) % 7) || 7);

type Props = {
  value: string | null;
  onChange: (v: string | null) => void;
  className?: string;
  label?: string;
  placeholder?: string;
};

export function DatePicker({ value, onChange, className, label, placeholder }: Props) {
  label ??= t('Fecha');
  placeholder ??= t('Fecha');
  const [open, setOpen] = useState(false);
  const today = isoOf(new Date());
  const [cursor, setCursor] = useState(value ?? today);
  const gridRef = useRef<HTMLDivElement>(null);

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };
  const openAt = () => {
    setCursor(value ?? today);
    setOpen(true);
  };

  useEffect(() => {
    if (open) gridRef.current?.focus();
  }, [open]);

  const month = cursor.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
  const weeks = days[35].slice(0, 7) === month ? 6 : 5;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(cursor);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor(addDays(cursor, -1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setCursor(addDays(cursor, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(addDays(cursor, -7));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(addDays(cursor, 7));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setCursor(isoOf(new Date(y, m - 1 + (e.shiftKey ? -12 : -1), dateOf(cursor).getDate())));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setCursor(isoOf(new Date(y, m - 1 + (e.shiftKey ? 12 : 1), dateOf(cursor).getDate())));
    }
  };

  return (
    <>
      <button type="button" className={className} aria-label={label} onClick={openAt}>
        {value ? cap(dueLabel(value)) : <span className="dp-placeholder">{placeholder}</span>}
      </button>
      {open && (
        <div className="overlay dp-overlay" onMouseDown={() => setOpen(false)}>
          <div className="surface-3 popover dp-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dp-head">
              <button type="button" className="dp-nav" aria-label={t('Mes anterior')} onClick={() => setCursor(isoOf(new Date(y, m - 2, dateOf(cursor).getDate())))}>
                ‹
              </button>
              <span className="dp-month">{cap(dateFmt({ month: 'long', year: 'numeric' }).format(dateOf(`${month}-01`)))}</span>
              <button type="button" className="dp-nav" aria-label={t('Mes siguiente')} onClick={() => setCursor(isoOf(new Date(y, m, dateOf(cursor).getDate())))}>
                ›
              </button>
            </div>
            <div
              className="dp-grid"
              style={{ '--weeks': weeks } as CSSProperties}
              role="grid"
              aria-label={label}
              tabIndex={0}
              ref={gridRef}
              onKeyDown={onKeyDown}
            >
              {dows().map((d, k) => (
                <span key={k} className="dp-dow">
                  {d}
                </span>
              ))}
              {days.slice(0, weeks * 7).map((iso) => (
                <button
                  type="button"
                  key={iso}
                  tabIndex={-1}
                  className={`dp-day${iso.slice(0, 7) !== month ? ' is-other' : ''}${iso === today ? ' is-today' : ''}${iso === value ? ' is-on' : ''}${
                    iso === cursor && iso !== value ? ' is-cursor' : ''
                  }${value && iso !== value && daysUntil(iso) < 0 ? ' is-past' : ''}`}
                  onClick={() => pick(iso)}
                  onMouseEnter={() => setCursor(iso)}
                >
                  {Number(iso.slice(8))}
                </button>
              ))}
            </div>
            <div className="dp-foot">
              <button type="button" className="dp-quick" onClick={() => pick(today)}>
                {t('Hoy')}
              </button>
              <button type="button" className="dp-quick" onClick={() => pick(addDays(today, 1))}>
                {t('Mañana')}
              </button>
              <button type="button" className="dp-quick" onClick={() => pick(nextMonday(today))}>
                {t('Próximo lunes')}
              </button>
              {value && (
                <button type="button" className="dp-quick dp-clear" onClick={() => onChange(null)}>
                  {t('Quitar fecha')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
