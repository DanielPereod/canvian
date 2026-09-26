import { useEffect } from 'react';
import { ACTIONS, FIXED, matches, useKeymap } from './keys';
import { Keys } from './Kbd';

// La lista de atajos, en un panel que se abre con Ctrl+H (o lo que elijas).
export function Help({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const keymap = useKeymap();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || matches(e, 'help')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  return (
    <div className="overlay" onMouseDown={onClose} data-keys-modal>
      <div className="surface-3 popover help" role="dialog" aria-label="Atajos de teclado" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="label">Atajos</span>
          <button className="sheet-back meta" onClick={onSettings}>
            Cambiarlos
          </button>
        </div>
        <div className="help-cols">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="settings-subheading">{g}</h3>
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div key={a.id} className="help-row">
                  <Keys combo={keymap[a.id]} />
                  <span>{a.label}</span>
                </div>
              ))}
            </section>
          ))}
          <section>
            <h3 className="settings-subheading">Siempre</h3>
            {FIXED.map((f) => (
              <div key={f.label} className="help-row">
                <span className="keys">
                  {f.keys.map((k) => (
                    <Keys key={k} combo={k} />
                  ))}
                </span>
                <span>{f.label}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
