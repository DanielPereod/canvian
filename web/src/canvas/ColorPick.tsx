import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';

// La última muestra de una fila de colores: cualquier otro color. Abre un
// selector propio (cuadro de saturación y luz, barra de tono y el código
// #rrggbb), que se coloca siempre dentro de la ventana. Mientras no se ha
// elegido uno propio la muestra es un aro de arcoíris con un «+»; con uno
// elegido, se ve de ese color.

export const isHex = (c: string | null | undefined): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// Arrastrar dentro de una caja da la posición, de 0 a 1.
function drag(e: ReactPointerEvent<HTMLElement>, on: (x: number, y: number) => void) {
  const el = e.currentTarget;
  const at = (ev: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    on(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
  };
  e.preventDefault();
  el.setPointerCapture?.(e.pointerId);
  at(e);
  const move = (ev: PointerEvent) => at(ev);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

const W = 232;

function Popover({ anchor, side, start, onPick, onClose }: { anchor: DOMRect; side: 'below' | 'left'; start: string; onPick: (hex: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(start));
  const hex = hsvToHex(hsv);
  const [text, setText] = useState(hex);
  useEffect(() => setText(hex), [hex]);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);

  // Siempre dentro de la ventana: debajo (o a la izquierda) de la muestra, y si no cabe, al otro lado.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 260;
    const clampX = (x: number) => Math.max(8, Math.min(x, innerWidth - W - 8));
    const clampY = (y: number) => Math.max(8, Math.min(y, innerHeight - h - 8));
    if (side === 'left') {
      const x = anchor.left - W - 10 >= 8 ? anchor.left - W - 10 : anchor.right + 10;
      setSpot({ x: clampX(x), y: clampY(anchor.top + anchor.height / 2 - h / 2) });
    } else {
      const y = anchor.bottom + 8 + h <= innerHeight - 8 ? anchor.bottom + 8 : anchor.top - h - 8;
      setSpot({ x: clampX(anchor.left + anchor.width / 2 - W / 2), y: clampY(y) });
    }
  }, [anchor, side]);

  useEffect(() => {
    const away = (e: Event) => {
      const n = e.target as Element;
      if (!ref.current?.contains(n) && !n.closest?.('.color-pick')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const use = () => {
    onPick(hex);
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="color-pop"
      role="dialog"
      aria-label={t('Otro color…')}
      style={{ left: spot?.x ?? -9999, top: spot?.y ?? -9999, width: W }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') use();
      }}
    >
      <div
        className="color-pop-sv"
        style={{ '--hue': `hsl(${hsv.h} 100% 50%)` } as CSSProperties}
        onPointerDown={(e) => drag(e, (x, y) => setHsv((c) => ({ ...c, s: x, v: 1 - y })))}
      >
        <span className="color-pop-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <div className="color-pop-hue" onPointerDown={(e) => drag(e, (x) => setHsv((c) => ({ ...c, h: Math.min(359.9, x * 360) })))}>
        <span className="color-pop-knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className="color-pop-row">
        <span className="color-pop-prev" style={{ background: hex }} />
        <input
          className="field color-pop-hex"
          value={text}
          spellCheck={false}
          aria-label={t('Código del color')}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            const full = v.startsWith('#') ? v : `#${v}`;
            if (isHex(full)) setHsv(hexToHsv(full.toLowerCase()));
          }}
        />
        <button className="btn btn-primary color-pop-use" onClick={use}>
          {t('Usar')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

type Props = {
  /** El color propio elegido, si lo hay (#rrggbb). */
  value: string | null;
  onPick: (hex: string) => void;
  className?: string;
  role?: string;
  /** Dónde se abre: debajo de la muestra o a su izquierda (en la barra del lápiz, que está a la derecha). */
  side?: 'below' | 'left';
};

export function ColorPick({ value, onPick, className = 'bib-swatch', role, side = 'below' }: Props) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<DOMRect | null>(null);
  const on = isHex(value);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${className} color-pick${on ? ' is-on is-set' : ''}${open ? ' is-open' : ''}`}
        style={on ? ({ '--tint': value, '--draw-c': value } as CSSProperties) : undefined}
        title={t('Otro color…')}
        aria-label={t('Otro color…')}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        role={role}
        aria-checked={role ? on : undefined}
        onClick={() => setOpen(open ? null : (btn.current?.getBoundingClientRect() ?? null))}
      >
        <span aria-hidden="true" />
      </button>
      {open && <Popover anchor={open} side={side} start={on ? value.toLowerCase() : '#5b8def'} onPick={onPick} onClose={() => setOpen(null)} />}
    </>
  );
}
