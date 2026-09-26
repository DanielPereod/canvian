import { useState, type KeyboardEvent } from 'react';

// Elegir a qué sección va una nota: todas las secciones del perfil con su
// ruta, filtrables escribiendo, y «Sin sección».

export type SectionOption = { id: string | null; path: string };

type Props = {
  options: SectionOption[];
  current: string | null;
  onPick: (zoneId: string | null) => void;
  onClose: () => void;
};

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function SectionPicker({ options, current, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const q = norm(query.trim());
  const items = options.filter((o) => !q || norm(o.path).includes(q));
  const at = Math.min(cursor, Math.max(0, items.length - 1));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(Math.min(at + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === 'Enter' && items[at]) onPick(items[at].id);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="field field-bare"
          autoFocus
          placeholder="Mover a la sección…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="popover-divider" />
        <ul className="list" role="listbox">
          {items.map((o, i) => (
            <li
              key={o.id ?? 'none'}
              role="option"
              aria-selected={i === at}
              className={`list-item${o.id === current ? ' is-current' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(o.id)}
            >
              <span className={o.id ? undefined : 'faint'}>{o.path}</span>
              {o.id === current && <span className="meta list-note">aquí está</span>}
            </li>
          ))}
          {!items.length && <li className="list-item static">Ninguna sección se llama así.</li>}
        </ul>
      </div>
    </div>
  );
}
