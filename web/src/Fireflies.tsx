import { memo, useMemo, type CSSProperties } from 'react';

// Posiciones pseudoaleatorias pero estables entre renders.
function rand(seed: number) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function FirefliesView({ count = 16 }: { count?: number }) {
  const flies = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        left: `${rand(i + 1) * 100}%`,
        // Más densas abajo, como luz que sube del suelo
        top: `${55 + rand(i + 50) * 45}%`,
        '--d': `${10 + rand(i + 100) * 14}s`,
        '--t': `${2.4 + rand(i + 150) * 3}s`,
        '--delay': `${-rand(i + 200) * 12}s`,
        '--dx': `${(rand(i + 250) - 0.5) * 80}px`,
        '--dy': `${-20 - rand(i + 300) * 70}px`,
        '--o': `${0.35 + rand(i + 350) * 0.5}`,
      })),
    [count],
  );
  return (
    <div className="fireflies" aria-hidden="true">
      {flies.map((style, i) => (
        <span key={i} className="firefly" style={style as CSSProperties} />
      ))}
    </div>
  );
}

export const Fireflies = memo(FirefliesView);
