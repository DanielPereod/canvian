import { useState, type KeyboardEvent } from 'react';
import { ACTIONS, useKeymap } from './keys';
import { Keys } from './Kbd';
import { MODES, setMode, useAppearance } from './theme';

// Paleta de comandos: todas las acciones con su atajo. Elegir una la ejecuta
// como si se hubiera pulsado su tecla, así cada vista la atiende como siempre.

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Marca de las pulsaciones que manda la paleta (Foco no las toma por texto).
export const FROM_PALETTE = Symbol('palette');

export function pressAction(combo: string) {
  const parts = combo.split(/\+(?!$)/);
  const k = parts[parts.length - 1];
  const mod = parts.includes('mod');
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const key = k.length === 1 ? k : k === 'space' ? ' ' : k[0].toUpperCase() + k.slice(1);
  const code = /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : '';
  const ev = new KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: mod && !MAC,
    metaKey: mod && MAC,
    altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'),
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, FROM_PALETTE, { value: true });
  document.body.dispatchEvent(ev);
}

export function ActionPalette({ onClose }: { onClose: () => void }) {
  const keymap = useKeymap();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const words = norm(query).split(/\s+/).filter(Boolean);
  // Primero las que coinciden en el nombre corto, sin lo que va entre paréntesis.
  const short = (label: string) => norm(label.split(' (')[0]);
  const { mode } = useAppearance();
  // Las acciones con atajo y, además, órdenes sin tecla (como elegir el modo).
  type Entry = { key: string; label: string; group: string; combo?: string; run: () => void; on?: boolean };
  const entries: Entry[] = [
    ...ACTIONS.filter((a) => a.id !== 'commands').map((a) => ({ key: a.id, label: a.label, group: a.group, combo: keymap[a.id], run: () => setTimeout(() => pressAction(keymap[a.id]), 0) })),
    ...MODES.map((m) => ({ key: `mode-${m.id}`, label: `Modo ${m.name.toLowerCase()}${m.id === 'auto' ? ' (según el sistema)' : ''}`, group: 'Aspecto tema claro oscuro', run: () => void setMode(m.id).catch(() => {}), on: mode === m.id })),
  ];
  const items = entries
    .filter((a) => words.every((w) => norm(`${a.label} ${a.group}`).includes(w)))
    .map((a, i) => ({ a, rank: (short(a.label).startsWith(norm(query.trim())) ? 0 : words.every((w) => short(a.label).includes(w)) ? 1 : 2) * 100 + i }))
    .sort((x, y) => x.rank - y.rank)
    .map((x) => x.a);
  const at = Math.min(cursor, Math.max(0, items.length - 1));

  // Tras cerrar, para que la pulsación llegue a la vista y no a este campo.
  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(Math.min(at + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === 'Enter') run(items[at]);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="field field-bare"
          autoFocus
          placeholder="Escribe un comando"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="popover-divider" />
        <ul className="list" role="listbox">
          {items.map((a, i) => (
            <li
              key={a.key}
              role="option"
              aria-selected={i === at}
              ref={i === at ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className="list-item"
              style={{ '--i': i } as React.CSSProperties}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(a)}
            >
              {a.label}
              <span className="trail">{a.combo ? <Keys combo={a.combo} /> : a.on ? <span className="meta">Activo</span> : null}</span>
            </li>
          ))}
          {!items.length && <li className="list-item static">Ningún comando se llama así</li>}
        </ul>
      </div>
    </div>
  );
}
