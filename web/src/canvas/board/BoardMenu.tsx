import { useRef, type CSSProperties } from 'react';
import { useContextMenu } from '../Biblioteca';
import { t } from '../../i18n';

// El menú del clic derecho en el lienzo: sobre una tarjeta, una flecha, un
// dibujo o el vacío. Usa el mismo aspecto que los demás menús de la app.

export type BoardMenuItem = { label: string; key?: string; danger?: boolean; run: () => void } | null;

// Los colores de JSON Canvas: «1» a «6» son rojo, naranja, amarillo, verde,
// turquesa y violeta (así los lee también Obsidian).
export const CARD_COLORS: { id: string; name: string; css: string }[] = [
  { id: '1', name: 'Rojo', css: 'var(--draw-red)' },
  { id: '2', name: 'Naranja', css: 'var(--draw-orange)' },
  { id: '3', name: 'Amarillo', css: 'oklch(0.8 0.13 95)' },
  { id: '4', name: 'Verde', css: 'var(--draw-green)' },
  { id: '5', name: 'Turquesa', css: 'oklch(0.72 0.1 195)' },
  { id: '6', name: 'Violeta', css: 'oklch(0.66 0.13 300)' },
];

// El color con el que se pinta una tarjeta: uno de los de arriba o uno #rrggbb.
export function cardTint(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return CARD_COLORS.find((c) => c.id === color)?.css ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined);
}

type Props = {
  x: number;
  y: number;
  items: BoardMenuItem[];
  // Con `color`, una fila de muestras para teñir lo elegido.
  color?: { value: string | null; onPick: (c: string | null) => void };
  onClose: () => void;
};

export function BoardMenu({ x, y, items, color, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  // Sin separadores sueltos al principio, al final ni dos seguidos.
  const list = items.filter((it, i, a) => it || (i > 0 && i < a.length - 1 && a[i - 1]));
  return (
    <div className="bib-menu board-menu" ref={ref} role="menu" style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()}>
      {list.map((it, i) =>
        it ? (
          <button
            key={i}
            role="menuitem"
            className={`bib-menu-it${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
            {it.key && <span className="bib-menu-k">{it.key}</span>}
          </button>
        ) : (
          <div key={i} className="bib-menu-sep" role="separator" />
        ),
      )}
      {color && (
        <>
          <div className="bib-menu-sep" role="separator" />
          <div className="bib-menu-colors" role="group" aria-label={t('Color')}>
            {CARD_COLORS.map((c) => (
              <button
                key={c.id}
                role="menuitemradio"
                aria-checked={color.value === c.id}
                className={`bib-swatch${color.value === c.id ? ' is-on' : ''}`}
                style={{ '--tint': c.css } as CSSProperties}
                title={t(c.name)}
                aria-label={t(c.name)}
                onClick={() => color.onPick(c.id)}
              />
            ))}
            <button
              role="menuitemradio"
              aria-checked={!color.value}
              className={`bib-swatch board-swatch-none${!color.value ? ' is-on' : ''}`}
              title={t('Sin color')}
              aria-label={t('Sin color')}
              onClick={() => color.onPick(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}
