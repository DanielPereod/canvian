import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { TOUCH } from './touch';

// Un desplegable con buscador para los filtros, el orden y las propiedades de
// las vistas. Sustituye al <select> de siempre, que con muchas propiedades o
// valores se volvía una lista interminable: aquí se escribe para filtrar, se
// mueve uno con las flechas y se elige con Intro; la lista tiene un alto
// máximo y solo pinta las primeras coincidencias.

export type ComboItem = { id: string; label: string; icon?: ReactNode };

// Con pocas opciones (operadores, dirección) no hace falta buscar.
const SEARCH_FROM = 8;
// Lo que se pinta de una vez; el resto aparece al escribir.
const LIMIT = 150;

// Sin mayúsculas ni tildes: «canción» se encuentra escribiendo «cancion».
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function matches(label: string, query: string) {
  const q = fold(query.trim());
  return !q || fold(label).includes(q);
}

type Props = {
  items: ComboItem[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  // El texto del botón cuando el valor no está entre las opciones.
  missing?: string;
  // Abrirse nada más aparecer (al añadir un filtro u orden).
  autoOpen?: boolean;
  className?: string;
  label?: string;
  // Buscador siempre, aunque haya pocas opciones (propiedades y valores).
  search?: boolean;
  disabled?: boolean;
};

export function Combo({ items, value, onChange, placeholder, missing, autoOpen, className, label, search, disabled }: Props) {
  const [open, setOpen] = useState(!!autoOpen);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const current = items.find((i) => i.id === value);
  return (
    <>
      <button
        ref={setBtn}
        type="button"
        className={`cv-select cv-combo${open ? ' is-open' : ''}${current ? '' : ' is-empty'}${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        title={current?.label ?? missing ?? placeholder}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current?.icon}
        <span className="bib-ellipsis">{current?.label ?? (value && missing) ?? placeholder ?? t('Elige…')}</span>
        <svg className="cv-combo-caret" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M2.5 4l2.5 2.5L7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && btn && !disabled && (
        <ComboList
          anchor={btn}
          items={items}
          value={value}
          search={search ?? items.length >= SEARCH_FROM}
          onPick={(id) => {
            setOpen(false);
            btn.focus();
            if (id !== value) onChange(id);
          }}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) btn.focus();
          }}
        />
      )}
    </>
  );
}

function ComboList({ anchor, items, value, search, onPick, onClose }: { anchor: HTMLElement; items: ComboItem[]; value: string | null; search: boolean; onPick: (id: string) => void; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const found = items.filter((i) => matches(i.label, q));
  const shown = found.slice(0, LIMIT);
  const [hi, setHi] = useState(() => Math.max(0, shown.findIndex((i) => i.id === value)));
  const [spot, setSpot] = useState<{ left: number; top: number; minWidth: number } | null>(null);

  useEffect(() => setHi(q ? 0 : Math.max(0, shown.findIndex((i) => i.id === value))), [q]);

  // Debajo del botón, o encima si abajo no cabe.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect();
      // offsetWidth y no getBoundingClientRect: la entrada la encoge un poco.
      const h = ref.current?.offsetHeight ?? 0;
      const w = Math.max(ref.current?.offsetWidth ?? 0, a.width);
      const below = a.bottom + 4;
      const top = below + h > innerHeight - 8 && a.top - 4 - h > 8 ? a.top - 4 - h : Math.min(below, innerHeight - h - 8);
      setSpot({ left: Math.max(8, Math.min(a.left, innerWidth - w - 8)), top: Math.max(8, top), minWidth: a.width });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [anchor]);

  useEffect(() => {
    // En el móvil no se enfoca el buscador: el teclado taparía la lista.
    (search && !TOUCH ? input.current : list.current)?.focus();
    const away = (e: Event) => {
      const el = e.target as Node;
      if (ref.current?.contains(el) || anchor.contains(el)) return;
      onClose(false);
    };
    // Si se desplaza la ventanita de debajo, el botón se mueve: mejor cerrar.
    const scroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, []);

  // Que la opción resaltada se vea al moverse con las flechas.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const onKey = (e: React.KeyboardEvent) => {
    const n = shown.length;
    const go = (to: number) => {
      e.preventDefault();
      if (n) setHi(Math.max(0, Math.min(n - 1, to)));
    };
    if (e.key === 'ArrowDown') go(hi + 1);
    else if (e.key === 'ArrowUp') go(hi - 1);
    else if (e.key === 'Home' && !q) go(0);
    else if (e.key === 'End' && !q) go(n - 1);
    else if (e.key === 'PageDown') go(hi + 8);
    else if (e.key === 'PageUp') go(hi - 8);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[hi]) onPick(shown[hi].id);
    } else if (e.key === 'Escape') {
      // Solo se cierra esta lista, no la ventanita en la que está.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      onClose(true);
    } else if (e.key === 'Tab') onClose(false);
  };

  return createPortal(
    <div
      ref={ref}
      className="bib-menu cv-combo-pop"
      data-keys-modal
      data-popover
      data-combo
      // Hasta medirse, fuera de la pantalla (oculta no podría recibir el foco).
      style={spot ? { left: spot.left, top: spot.top, minWidth: spot.minWidth } : { left: -9999, top: 0 }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {search && (
        <input
          ref={input}
          className="nprop-menu-input cv-combo-search"
          value={q}
          placeholder={t('Buscar…')}
          aria-label={t('Buscar…')}
          aria-activedescendant={shown[hi] ? `cv-combo-${hi}` : undefined}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div ref={list} className="cv-combo-list" role="listbox" tabIndex={-1}>
        {shown.map((it, i) => (
          <button
            key={it.id}
            id={`cv-combo-${i}`}
            data-i={i}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={it.id === value}
            className={`bib-menu-it cv-combo-it${i === hi ? ' is-hi' : ''}${it.id === value ? ' is-on' : ''}`}
            onPointerMove={() => i !== hi && setHi(i)}
            onClick={() => onPick(it.id)}
          >
            {it.icon}
            <span className="bib-ellipsis">{it.label}</span>
            {it.id === value && <span className="bib-menu-k">✓</span>}
          </button>
        ))}
        {!found.length && <div className="bib-menu-head">{t('Nada coincide con «{q}»', { q: q.trim() })}</div>}
        {found.length > shown.length && <div className="bib-menu-head">{t('Y {n} más: escribe para afinar', { n: found.length - shown.length })}</div>}
      </div>
    </div>,
    document.body,
  );
}
