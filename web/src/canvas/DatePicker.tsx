import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { dateFmt, daysUntil, dueLabel } from './dates';
import { t } from '../i18n';
import { parseRecur, recurText, type Recur, type RecurUnit } from './tasks';
import { repeatLabel } from './repeat';
import { Combo } from './Combo';

// Selector de fecha propio, en vez del calendario nativo del navegador: un
// botón que abre un mes en cuadrícula, con mes anterior/siguiente, atajos
// (Hoy, Mañana, Próximo lunes) y se maneja también con el teclado.
// En las tareas, debajo se elige además si se repite (y cada cuánto).

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
  /** La repetición («every week»); con `onRepeat`, el selector la deja elegir. */
  repeat?: string | null;
  onRepeat?: (rule: string | null) => void;
};

const PRESETS: { rule: string; name: string }[] = [
  { rule: 'every day', name: 'Diaria' },
  { rule: 'every week', name: 'Semanal' },
  { rule: 'every month', name: 'Mensual' },
  { rule: 'every year', name: 'Anual' },
];
const UNITS: { id: RecurUnit; one: string; many: string }[] = [
  { id: 'day', one: 'día', many: 'días' },
  { id: 'week', one: 'semana', many: 'semanas' },
  { id: 'month', one: 'mes', many: 'meses' },
  { id: 'year', one: 'año', many: 'años' },
];
// De lunes a domingo (0 es domingo).
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function DatePicker({ value, onChange, className, label, placeholder, repeat, onRepeat }: Props) {
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
      <button type="button" className={className} aria-label={label} title={repeat ? repeatLabel(repeat) : undefined} onClick={openAt}>
        {value ? cap(dueLabel(value)) : <span className="dp-placeholder">{placeholder}</span>}
        {repeat && (
          <span className="dp-recur" aria-label={repeatLabel(repeat)}>
            {' '}🔁
          </span>
        )}
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
            {onRepeat && <RepeatPicker rule={repeat ?? null} onChange={onRepeat} />}
          </div>
        </div>
      )}
    </>
  );
}

// Si se repite: nunca, una de las de siempre o, en «Personalizada», cada
// cuántos días, semanas, meses o años (y qué días de la semana).
function RepeatPicker({ rule, onChange }: { rule: string | null; onChange: (rule: string | null) => void }) {
  const parsed = rule ? parseRecur(rule) : null;
  const preset = PRESETS.find((p) => p.rule === rule);
  const [custom, setCustom] = useState(!!rule && !preset);
  const r: Recur = parsed ?? { n: 1, unit: 'week', days: [], monthDay: null, whenDone: false };
  const put = (next: Partial<Recur>) => {
    const merged = { ...r, ...next };
    if (merged.unit !== 'week') merged.days = [];
    if (merged.unit !== 'month') merged.monthDay = null;
    onChange(recurText(merged));
  };
  return (
    <div className="dp-repeat">
      <div className="dp-repeat-row" role="radiogroup" aria-label={t('Repetir')}>
        <span className="dp-repeat-label" aria-hidden="true">
          🔁
        </span>
        <button
          type="button"
          role="radio"
          aria-checked={!rule && !custom}
          className={`dp-quick${!rule && !custom ? ' is-on' : ''}`}
          onClick={() => {
            setCustom(false);
            onChange(null);
          }}
        >
          {t('No se repite')}
        </button>
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p.rule}
            role="radio"
            aria-checked={!custom && rule === p.rule}
            className={`dp-quick${!custom && rule === p.rule ? ' is-on' : ''}`}
            onClick={() => {
              setCustom(false);
              onChange(p.rule);
            }}
          >
            {t(p.name)}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className={`dp-quick${custom ? ' is-on' : ''}`}
          onClick={() => {
            setCustom(true);
            if (!rule) put({});
          }}
        >
          {t('Personalizada')}
        </button>
      </div>
      {custom && (
        <div className="dp-custom">
          <label className="dp-every">
            {t('Cada')}
            <input
              type="number"
              min={1}
              max={99}
              value={r.n}
              aria-label={t('Cada cuántos')}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 1 && n <= 99) put({ n });
              }}
            />
            <Combo className="is-auto" items={UNITS.map((u) => ({ id: u.id, label: t(r.n === 1 ? u.one : u.many) }))} value={r.unit} label={t('Unidad')} onChange={(unit) => put({ unit: unit as RecurUnit })} />
          </label>
          {r.unit === 'week' && (
            <div className="dp-wdays" role="group" aria-label={t('Días de la semana')}>
              {WEEK.map((d) => {
                const on = r.days.includes(d);
                return (
                  <button
                    type="button"
                    key={d}
                    aria-pressed={on}
                    className={`dp-wday${on ? ' is-on' : ''}`}
                    title={cap(dateFmt({ weekday: 'long' }).format(new Date(2024, 0, 7 + d)))}
                    onClick={() => put({ days: on ? r.days.filter((x) => x !== d) : [...r.days, d].sort((a, b) => a - b) })}
                  >
                    {dateFmt({ weekday: 'narrow' }).format(new Date(2024, 0, 7 + d))}
                  </button>
                );
              })}
            </div>
          )}
          {r.unit === 'month' && (
            <div className="dp-wdays" role="radiogroup" aria-label={t('Qué día del mes')}>
              {[
                { v: null, name: t('El mismo día') },
                { v: -1, name: t('El último día') },
              ].map((o) => (
                <button type="button" key={String(o.v)} role="radio" aria-checked={r.monthDay === o.v} className={`dp-quick${r.monthDay === o.v ? ' is-on' : ''}`} onClick={() => put({ monthDay: o.v })}>
                  {o.name}
                </button>
              ))}
            </div>
          )}
          <label className="dp-whendone">
            <input type="checkbox" checked={r.whenDone} onChange={(e) => put({ whenDone: e.target.checked })} />
            {t('Contar desde que se hace')}
          </label>
        </div>
      )}
      {rule && <p className="dp-repeat-sum">{repeatLabel(rule)}</p>}
    </div>
  );
}
