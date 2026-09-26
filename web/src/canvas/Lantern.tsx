import { useState } from 'react';

type Props = { query: string; count: number; onChange: (q: string) => void; onClear: () => void };

// Buscador de la linterna. Enter lo pliega y deja la luz puesta; Esc la apaga.
export function Lantern({ query, count, onChange, onClear }: Props) {
  const [open, setOpen] = useState(true);

  if (!open)
    return (
      <div className="lantern surface-2 lantern-pill">
        <span className="lantern-dot" aria-hidden="true" />
        <button className="lantern-query" onClick={() => setOpen(true)} title="Cambiar filtro (F)">
          {query}
        </button>
        <span className="faint">{count}</span>
        <button className="lantern-x" onClick={onClear} aria-label="Apagar linterna">
          ×
        </button>
      </div>
    );

  return (
    <div className="lantern surface-3 lantern-open">
      <span className="lantern-dot" aria-hidden="true" />
      <input
        className="field-bare"
        autoFocus
        value={query}
        placeholder="Alumbrar… (prio:alta, vence:semana, estado:curso)"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClear();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (query.trim()) setOpen(false);
            else onClear();
          }
        }}
      />
      <span className="faint lantern-count">{query.trim() ? `${count} con luz` : ''}</span>
    </div>
  );
}
