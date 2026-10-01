import type { TouchEvent } from 'react';

// En el móvil no hay ratón ni teclado: lo que en el ordenador es clic derecho
// o arrastrar, allí es mantener pulsado.

// Pantalla táctil sin ratón (un móvil o una tableta).
export const TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

const HOLD_MS = 480;
let timer = 0;
let start: { x: number; y: number } | null = null;
let fired = false;

// Mantener pulsado abre el menú donde está el dedo (y el toque ya no cuenta como clic).
export function longPress(open: (x: number, y: number) => void) {
  return {
    onTouchStart: (e: TouchEvent) => {
      clearTimeout(timer);
      fired = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      timer = window.setTimeout(() => {
        if (!start) return;
        fired = true;
        navigator.vibrate?.(8);
        open(start.x, start.y);
      }, HOLD_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) {
        clearTimeout(timer);
        start = null;
      }
    },
    onTouchEnd: (e: TouchEvent) => {
      clearTimeout(timer);
      start = null;
      if (fired && e.cancelable) e.preventDefault();
    },
    onTouchCancel: () => {
      clearTimeout(timer);
      start = null;
    },
  };
}
