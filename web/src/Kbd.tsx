import { keyParts } from './keys';

// Una combinación pintada en teclas: <Keys combo="mod+shift+e" />.
export function Keys({ combo }: { combo: string }) {
  const parts = keyParts(combo);
  if (!parts.length) return <span className="faint">Sin tecla</span>;
  return (
    <span className="keys">
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  );
}
