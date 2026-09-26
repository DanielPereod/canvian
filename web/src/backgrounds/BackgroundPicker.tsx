import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { BackgroundKind } from '../api';
import { BACKGROUNDS } from './catalog';

type Props = {
  current: BackgroundKind;
  onPreview: (kind: BackgroundKind) => void;
  onChoose: (kind: BackgroundKind) => void;
  onCancel: () => void;
};

// Al moverte por la lista el fondo cambia en vivo; Enter lo guarda y Esc lo deja como estaba.
export function BackgroundPicker({ current, onPreview, onChoose, onCancel }: Props) {
  const [cursor, setCursor] = useState(Math.max(0, BACKGROUNDS.findIndex((b) => b.id === current)));

  const move = (i: number) => {
    setCursor(i);
    onPreview(BACKGROUNDS[i].id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key.toLowerCase() === 'b') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      move((cursor + 1) % BACKGROUNDS.length);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      move((cursor - 1 + BACKGROUNDS.length) % BACKGROUNDS.length);
    } else if (e.key === 'Enter') onChoose(BACKGROUNDS[cursor].id);
  };

  return (
    <div className="overlay overlay-clear" onMouseDown={onCancel}>
      <div
        className="surface-3 popover bg-picker"
        role="listbox"
        tabIndex={0}
        autoFocus
        ref={(el) => el?.focus()}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="bg-picker-head">
          <span className="label">Fondo</span>
          <span className="faint bg-picker-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> probar · <kbd>Enter</kbd> guardar
          </span>
        </div>
        <div className="bg-grid">
          {BACKGROUNDS.map((b, i) => (
            <button
              key={b.id}
              role="option"
              aria-selected={i === cursor}
              className="bg-option"
              style={{ '--i': i } as CSSProperties}
              onMouseEnter={() => move(i)}
              onClick={() => onChoose(b.id)}
            >
              <span className={`bg-swatch bg-swatch-${b.id}`} aria-hidden="true" />
              <span className="bg-name">{b.name}</span>
              <span className="bg-hint">{b.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
