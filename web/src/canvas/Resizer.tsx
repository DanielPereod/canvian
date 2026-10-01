import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

// Barras laterales que se ensanchan arrastrando su borde. El ancho se guarda
// en el navegador; doble clic en el borde vuelve al de siempre.

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function useSideWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v ? clamp(v, min, max) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // Sin almacenamiento local se olvida al recargar; nada más.
    }
  }, [key, width]);
  const set = (v: number) => setWidth(clamp(Math.round(v), min, max));
  return { width, set, reset: () => setWidth(initial), min, max };
}
export type SideWidth = ReturnType<typeof useSideWidth>;

// El tirador. `edge` es el lado de la barra en el que está: una barra a la
// izquierda crece hacia la derecha y una a la derecha, al revés.
export function Resizer({ size, edge, className = '' }: { size: SideWidth; edge: 'left' | 'right'; className?: string }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });
  return (
    <div
      className={`side-resizer${dragging ? ' is-dragging' : ''} ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={size.width}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      title={t('Arrastra para cambiar el ancho · doble clic para volver al de siempre')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: size.width };
        setDragging(true);
        document.documentElement.classList.add('is-resizing');
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const dx = e.clientX - start.current.x;
        size.set(start.current.w + (edge === 'right' ? dx : -dx));
      }}
      onPointerUp={() => {
        setDragging(false);
        document.documentElement.classList.remove('is-resizing');
      }}
      onLostPointerCapture={() => {
        setDragging(false);
        document.documentElement.classList.remove('is-resizing');
      }}
      onDoubleClick={size.reset}
    />
  );
}
