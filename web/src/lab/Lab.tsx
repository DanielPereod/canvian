import { type CSSProperties, type KeyboardEvent } from 'react';
import { EXPERIMENTS, toggleExperiment, useExperiments } from './experiments';

// Panel para encender y apagar las ideas en prueba. 1–5 las alterna, E o Esc cierra.
export function Lab({ onClose }: { onClose: () => void }) {
  const on = useExperiments();

  const onKeyDown = (e: KeyboardEvent) => {
    const n = Number(e.key);
    if (e.key === 'Escape' || e.key.toLowerCase() === 'e') {
      e.preventDefault();
      onClose();
    } else if (n >= 1 && n <= EXPERIMENTS.length) {
      e.preventDefault();
      toggleExperiment(EXPERIMENTS[n - 1].id);
    }
  };

  return (
    <div className="overlay overlay-clear" onMouseDown={onClose}>
      <div
        className="surface-3 popover lab"
        tabIndex={0}
        ref={(el) => el?.focus()}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bg-picker-head">
          <span className="label">Laboratorio</span>
          <span className="faint bg-picker-keys">
            <kbd>1</kbd>–<kbd>5</kbd> encender o apagar
          </span>
        </div>
        <ul className="list">
          {EXPERIMENTS.map((x, i) => (
            <li
              key={x.id}
              role="switch"
              aria-checked={on[x.id]}
              className="list-item lab-item"
              style={{ '--i': i } as CSSProperties}
              onClick={() => toggleExperiment(x.id)}
            >
              <kbd>{i + 1}</kbd>
              <span className="lab-text">
                <span className="lab-name">{x.name}</span>
                <span className="lab-hint">{x.hint}</span>
              </span>
              <span className="switch" aria-hidden="true" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
