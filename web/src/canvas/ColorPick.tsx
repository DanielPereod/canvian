import { useEffect, useRef, type CSSProperties } from 'react';
import { t } from '../i18n';

// La última muestra de una fila de colores: cualquier otro color, con el
// selector del sistema. Mientras no se ha elegido uno propio se ve como un
// aro de arcoíris con un «+»; con uno elegido, se ve de ese color.

export const isHex = (c: string | null | undefined): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);

type Props = {
  /** El color propio elegido, si lo hay (#rrggbb). */
  value: string | null;
  onPick: (hex: string) => void;
  /** Mientras se arrastra en el selector (para verlo en vivo); al soltar llega `onPick`. */
  onLive?: (hex: string) => void;
  className?: string;
  role?: string;
};

export function ColorPick({ value, onPick, onLive, className = 'bib-swatch', role }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  // «change» llega al cerrar el selector; React solo da «input», que llega a cada paso.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => pick.current(el.value.toLowerCase());
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);
  const on = isHex(value);
  // Sin controlar (si no, React lo devolvería a su valor a cada paso del selector).
  useEffect(() => {
    if (ref.current && isHex(value)) ref.current.value = value.toLowerCase();
  }, [value]);
  return (
    <label
      className={`${className} color-pick${on ? ' is-on is-set' : ''}`}
      style={on ? ({ '--tint': value, '--draw-c': value } as CSSProperties) : undefined}
      title={t('Otro color…')}
      role={role}
      aria-checked={role ? on : undefined}
    >
      <input
        ref={ref}
        type="color"
        aria-label={t('Otro color…')}
        defaultValue={on ? value.toLowerCase() : '#5b8def'}
        onChange={(e) => onLive?.(e.target.value.toLowerCase())}
      />
      <span aria-hidden="true" />
    </label>
  );
}
