import { useEffect, useState, type CSSProperties } from 'react';
import type { Lens } from '../api';
import type { LensToken } from './lanternMatch';

export type LensMode = 'dim' | 'hide';

const MODES: { id: LensMode; name: string }[] = [
  { id: 'dim', name: 'Atenuar' },
  { id: 'hide', name: 'Ocultar' },
];

type Props = {
  open: boolean;
  query: string;
  count: number;
  tokens: LensToken[];
  mode: LensMode;
  lenses: Lens[];
  onOpen: () => void;
  onFold: () => void;
  onChange: (q: string) => void;
  onMode: (m: LensMode) => void;
  onSave: () => Promise<Lens | null>;
  onApply: (lens: Lens) => void;
  onDelete: (lens: Lens) => void;
  onClear: () => void;
};

export const nextMode = (m: LensMode): LensMode => MODES[(MODES.findIndex((x) => x.id === m) + 1) % MODES.length].id;

function Chips({ tokens }: { tokens: LensToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={`${t.raw}-${i}`} className={`lens-chip is-${t.kind}${t.negated ? ' negated' : ''}`} style={{ '--i': i } as CSSProperties} title={t.raw}>
          {t.label}
        </span>
      ))}
    </>
  );
}

// La lente (F): escribes una consulta y el mapa reacciona en vivo. Tab cambia
// entre atenuar y ocultar; Enter la pliega en una píldora; Esc la apaga.
export function Lantern(p: Props) {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 2200);
    return () => clearTimeout(t);
  }, [saved]);

  const save = async () => {
    if (!p.query.trim()) return;
    const lens = await p.onSave();
    if (lens) setSaved(lens.slot ? `Guardada en ⇧${lens.slot}` : 'Guardada');
  };

  const modeName = MODES.find((m) => m.id === p.mode)!.name;

  if (!p.open)
    return (
      <div className="lantern surface-2 lantern-pill">
        <span className="lantern-dot" aria-hidden="true" />
        <button className="lantern-query" onClick={p.onOpen} title="Cambiar filtro (F)">
          <Chips tokens={p.tokens} />
        </button>
        <button className="lantern-mode" onClick={() => p.onMode(nextMode(p.mode))} title="Cambiar modo (Tab)">
          {modeName}
        </button>
        <span className="faint">{p.count}</span>
        <button className="lantern-x" onClick={p.onClear} aria-label="Apagar lente">
          ×
        </button>
      </div>
    );

  const empty = !p.query.trim();

  return (
    <div className="lantern surface-3 lantern-open">
      <div className="lantern-row">
        <span className="lantern-dot" aria-hidden="true" />
        <input
          className="field-bare"
          autoFocus
          value={p.query}
          placeholder="Alumbrar… (tipo:tarea -hecha, prio:alta, vence:<7d)"
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              p.onClear();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (empty) p.onClear();
              else p.onFold();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              p.onMode(nextMode(p.mode));
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void save();
            }
          }}
        />
        <span className="faint lantern-count">{saved ?? (empty ? '' : `${p.count} con luz`)}</span>
      </div>

      {!empty && (
        <div className="lantern-chips">
          <Chips tokens={p.tokens} />
        </div>
      )}

      {!empty && (
        <div className="lantern-tools">
          <div className="lantern-modes" role="radiogroup" aria-label="Modo">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={p.mode === m.id} className={`chip${p.mode === m.id ? ' on' : ''}`} onClick={() => p.onMode(m.id)}>
                {m.name}
              </button>
            ))}
          </div>
          <button className="chip" onClick={() => void save()} title="Guardar lente (⌘/Ctrl S)">
            Guardar
          </button>
        </div>
      )}

      {empty && (
        <ul className="list lantern-lenses">
          {p.lenses.length ? (
            p.lenses.map((l, i) => (
              <li key={l.id} className="list-item" style={{ '--i': i } as CSSProperties} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onApply(l)}>
                <span className="lens-slot">{l.slot ? <kbd>⇧{l.slot}</kbd> : null}</span>
                <span className="lens-name">{l.name}</span>
                <span className="trail">{l.query}</span>
                <button
                  className="lantern-x"
                  aria-label={`Borrar ${l.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDelete(l);
                  }}
                >
                  ×
                </button>
              </li>
            ))
          ) : (
            <li className="list-item static">Escribe una consulta y guárdala con ⌘/Ctrl S para abrirla luego con ⇧1…⇧9</li>
          )}
        </ul>
      )}
    </div>
  );
}
