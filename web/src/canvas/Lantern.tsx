import { useEffect, useState, type CSSProperties } from 'react';
import type { Lens } from '../api';
import type { LensToken } from './lanternMatch';
import { t } from '../i18n';

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
      {tokens.map((tok, i) => (
        <span key={`${tok.raw}-${i}`} className={`lens-chip is-${tok.kind}${tok.negated ? ' negated' : ''}`} style={{ '--i': i } as CSSProperties} title={tok.raw}>
          {tok.label}
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
    const timer = setTimeout(() => setSaved(null), 2200);
    return () => clearTimeout(timer);
  }, [saved]);

  const save = async () => {
    if (!p.query.trim()) return;
    const lens = await p.onSave();
    if (lens) setSaved(t('Guardada'));
  };

  const modeName = t(MODES.find((m) => m.id === p.mode)!.name);

  if (!p.open)
    return (
      <div className="lantern surface-2 lantern-pill">
        <span className="lantern-dot" aria-hidden="true" />
        <button className="lantern-query" onClick={p.onOpen} title={t('Cambiar filtro (F)')}>
          <Chips tokens={p.tokens} />
        </button>
        <button className="lantern-mode" onClick={() => p.onMode(nextMode(p.mode))} title={t('Cambiar modo (Tab)')}>
          {modeName}
        </button>
        <span className="faint">{p.count}</span>
        <button className="lantern-x" onClick={p.onClear} aria-label={t('Apagar lente')}>
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
          placeholder={t('Alumbrar… (tipo:tarea, estado:curso, prio:alta, vence:<7d)')}
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
        <span className="faint lantern-count">{saved ?? (empty ? '' : t('{n} con luz', { n: p.count }))}</span>
      </div>

      {!empty && (
        <div className="lantern-chips">
          <Chips tokens={p.tokens} />
        </div>
      )}

      {!empty && (
        <div className="lantern-tools">
          <div className="lantern-modes" role="radiogroup" aria-label={t('Modo')}>
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={p.mode === m.id} className={`chip${p.mode === m.id ? ' on' : ''}`} onClick={() => p.onMode(m.id)}>
                {t(m.name)}
              </button>
            ))}
          </div>
          <button className="chip" onClick={() => void save()} title={t('Guardar lente (⌘/Ctrl S)')}>
            {t('Guardar')}
          </button>
        </div>
      )}

      {empty && (
        <ul className="list lantern-lenses">
          {p.lenses.length ? (
            p.lenses.map((l, i) => (
              <li key={l.id} className="list-item" style={{ '--i': i } as CSSProperties} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onApply(l)}>
                <span className="lens-name">{l.name}</span>
                <span className="trail">{l.query}</span>
                <button
                  className="lantern-x"
                  aria-label={t('Borrar {name}', { name: l.name })}
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
            <li className="list-item static">{t('Escribe una consulta y guárdala con ⌘/Ctrl S para tenerla aquí')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
