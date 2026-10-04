import { useEffect, useRef } from 'react';

// Gestos del móvil: deslizar hacia la derecha abre el cajón con la barra
// lateral y hacia la izquierda lo cierra, siguiendo al dedo. Solo cuando el
// cajón existe (pantalla estrecha) y nunca donde el dedo ya hace otra cosa:
// el canvas (mover y dibujar), el grafo, tablas que se desplazan de lado o
// texto seleccionado.

const NARROW = '(max-width: 760px)';
// Desde dónde vale empezar a abrir: el borde mismo es del sistema (atrás en
// Android), así que basta con empezar en la parte izquierda de la pantalla.
const START = 0.4;
const SLOP = 10;
const BUSY = '.board, .nodes.graph, .graph-canvas, input, textarea, select, .tbl-grip, .note-image-crop, .side-resizer, [data-noswipe]';
const OVER = '[role="dialog"], [role="menu"], .popover';

const root = () => document.documentElement;

// ¿Hay algo entre el dedo y la página que ya se desplaza de lado?
function scrollsSideways(el: Element | null) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const o = getComputedStyle(el).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
}

function selecting() {
  const s = document.getSelection();
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}

function drawerWidth() {
  const side = document.querySelector('.bib-dock.is-drawer .bib-side');
  return side?.getBoundingClientRect().width || Math.min(innerWidth * 0.86, 330);
}

// Coloca el cajón a `x` px de su sitio (0 abierto, -ancho cerrado).
function place(x: number, w: number) {
  root().style.setProperty('--drawer-x', `${x}px`);
  root().style.setProperty('--drawer-p', String(Math.max(0, Math.min(1, 1 + x / w))));
}

export function useDrawerSwipe(open: boolean, setOpen: (open: boolean) => void, enabled: boolean) {
  const state = useRef({ open, setOpen, enabled });
  state.current = { open, setOpen, enabled };

  useEffect(() => {
    let g: { x: number; y: number; opening: boolean; claimed: boolean; w: number; last: { x: number; t: number }[] } | null = null;
    let settle = 0;

    const end = () => {
      removeEventListener('touchmove', onMove);
      removeEventListener('touchend', onEnd);
      removeEventListener('touchcancel', onEnd);
    };

    const onStart = (e: TouchEvent) => {
      const s = state.current;
      if (!s.enabled || e.touches.length !== 1 || !matchMedia(NARROW).matches) return;
      const t = e.touches[0];
      const target = e.target as Element;
      if (s.open) {
        // Cerrar: desde el cajón o desde la sombra de al lado.
        if (!target.closest('.bib-dock.is-drawer')) return;
      } else {
        if (t.clientX > innerWidth * START || target.closest(BUSY) || document.querySelector(OVER)) return;
        if (scrollsSideways(target) || selecting()) return;
      }
      g = { x: t.clientX, y: t.clientY, opening: !s.open, claimed: false, w: 0, last: [{ x: t.clientX, t: e.timeStamp }] };
      addEventListener('touchmove', onMove, { passive: false });
      addEventListener('touchend', onEnd);
      addEventListener('touchcancel', onEnd);
    };

    const onMove = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return onEnd();
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.claimed) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Solo un gesto claramente de lado y en la dirección que toca.
        if (Math.abs(dx) < Math.abs(dy) * 1.5 || (g.opening ? dx < 0 : dx > 0) || (g.opening && selecting())) {
          g = null;
          return end();
        }
        g.claimed = true;
        clearTimeout(settle);
        root().classList.remove('drawer-settle');
        root().classList.add('drawer-drag');
        if (g.opening) {
          g.w = Math.min(innerWidth * 0.86, 330);
          place(-g.w, g.w);
          state.current.setOpen(true);
        } else g.w = drawerWidth();
        // Lo que el dedo empezó (un mantener pulsado, un clic) ya no cuenta.
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      if (e.cancelable) e.preventDefault();
      g.last.push({ x: t.clientX, t: e.timeStamp });
      if (g.last.length > 5) g.last.shift();
      // Al abrir, el cajón empieza escondido y asoma con el dedo.
      const move = g.opening ? dx - g.w : dx;
      place(Math.max(-g.w, Math.min(0, move)), g.w);
    };

    const onEnd = () => {
      end();
      const cur = g;
      g = null;
      if (!cur?.claimed) return;
      const a = cur.last[0];
      const b = cur.last[cur.last.length - 1];
      const v = (b.x - a.x) / Math.max(1, b.t - a.t);
      const x = parseFloat(root().style.getPropertyValue('--drawer-x')) || 0;
      const shown = 1 + x / cur.w;
      // Un tirón rápido decide; si no, cuenta hasta dónde llegó.
      const stay = Math.abs(v) > 0.35 ? v > 0 : shown > 0.45;
      root().classList.add('drawer-settle');
      place(stay ? 0 : -cur.w, cur.w);
      settle = window.setTimeout(() => {
        root().classList.remove('drawer-drag', 'drawer-settle');
        // Ya está abierto: sin esto, la animación de entrada volvería a empezar.
        if (stay) root().classList.add('drawer-still');
        else state.current.setOpen(false);
      }, 200);
      // El clic que sigue al gesto no debe elegir nada del cajón.
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 350);
    };

    addEventListener('touchstart', onStart, { passive: true });
    return () => {
      removeEventListener('touchstart', onStart);
      end();
      clearTimeout(settle);
      root().classList.remove('drawer-drag', 'drawer-settle', 'drawer-still');
    };
  }, []);

  // Cerrado (por lo que sea), la próxima vez que se abra con el botón sí se anima.
  useEffect(() => {
    if (!open) root().classList.remove('drawer-still');
  }, [open]);
}

// Atrás (el gesto o el botón de Android, o el del navegador) deshace el
// último paso dentro de la app: cierra el cajón, la nota, sube un nivel…
// Mientras hay algo que deshacer se guarda un paso en el historial; si ya no
// queda nada, atrás sale de la app como siempre.
export function useBackStep(deep: boolean, back: () => boolean) {
  const backRef = useRef(back);
  backRef.current = back;
  const guarded = useRef(false);

  useEffect(() => {
    if (!deep || guarded.current) return;
    if (history.state?.canvianBack) guarded.current = true;
    else {
      history.pushState({ ...(history.state ?? {}), canvianBack: true }, '');
      guarded.current = true;
    }
  });

  useEffect(() => {
    const onPop = () => {
      if (!guarded.current || history.state?.canvianBack) return;
      guarded.current = false;
      if (!backRef.current()) history.back();
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
}

// Deslizar hacia abajo desde la barra de arriba abre la paleta de comandos.
// Solo desde la barra: en el resto de la pantalla, bajar el dedo es desplazarse.
const PULL = 70;

export function usePullDown(onPull: () => void, enabled: boolean) {
  const state = useRef({ onPull, enabled });
  state.current = { onPull, enabled };

  useEffect(() => {
    let g: { x: number; y: number; claimed: boolean } | null = null;

    const end = () => {
      g = null;
      removeEventListener('touchmove', onMove);
      removeEventListener('touchend', end);
      removeEventListener('touchcancel', end);
    };

    const onStart = (e: TouchEvent) => {
      if (!state.current.enabled || e.touches.length !== 1 || !TOUCHY()) return;
      const target = e.target as Element;
      if (!target.closest('.bib-bar') || target.closest('input, textarea, [contenteditable="true"]') || document.querySelector(OVER)) return;
      const t = e.touches[0];
      g = { x: t.clientX, y: t.clientY, claimed: false };
      addEventListener('touchmove', onMove, { passive: false });
      addEventListener('touchend', end);
      addEventListener('touchcancel', end);
    };

    const onMove = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return end();
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.claimed) {
        if (Math.hypot(dx, dy) < SLOP) return;
        if (dy < 0 || dy < Math.abs(dx) * 1.5) return end();
        g.claimed = true;
      }
      // Que el navegador no lo tome por «tirar para recargar».
      if (e.cancelable) e.preventDefault();
      if (dy > PULL) {
        end();
        navigator.vibrate?.(8);
        (document.activeElement as HTMLElement | null)?.blur?.();
        state.current.onPull();
      }
    };

    addEventListener('touchstart', onStart, { passive: true });
    return () => {
      removeEventListener('touchstart', onStart);
      end();
    };
  }, []);
}

// Pantalla táctil (el cajón y la barra cambian con el ancho, esto no).
const TOUCHY = () => matchMedia('(pointer: coarse)').matches;
