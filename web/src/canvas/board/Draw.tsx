import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { DRAW_COLORS, DRAW_SIZES, drawingPaths, fontSize, hitPath, penWidth, type DrawColor, type DrawSize, type Drawing, type Tool } from './draw';
import { t } from '../../i18n';

// La capa de dibujo (va dentro del lienzo, así que se mueve y se acerca con
// las tarjetas) y su barra de herramientas.

export type Typing = { id: string; x: number; y: number; text: string; color: DrawColor; size: DrawSize };

type LayerProps = {
  drawings: Drawing[];
  draft: Drawing | null;
  selected: string | null;
  erasing: Set<string>;
  typing: Typing | null;
  onShapeDown: (e: ReactPointerEvent, id: string) => void;
  onTextEdit: (d: Drawing) => void;
  onTyping: (text: string) => void;
  onTypingDone: () => void;
};

function Shape({ d, faded, onDown, onEdit }: { d: Drawing; faded?: boolean; onDown?: (e: ReactPointerEvent) => void; onEdit?: () => void }) {
  const cls = `draw-shape draw-c-${d.color}${faded ? ' is-erasing' : ''}`;
  if (d.kind === 'text') {
    const fs = fontSize(d.size);
    return (
      <g className={cls} data-draw={d.id}>
        <text
          x={d.x}
          y={d.y}
          className="draw-text draw-hit-text nopan nodrag"
          data-draw-id={d.id}
          style={{ fontSize: fs }}
          onPointerDown={onDown}
          onDoubleClick={onEdit}
        >
          {d.text.split('\n').map((line, i) => (
            <tspan key={i} x={d.x} dy={i ? fs * 1.25 : 0}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      </g>
    );
  }
  return (
    <g className={cls} data-draw={d.id}>
      {drawingPaths(d).map((p, i) => (d.kind === 'pen' ? <path key={i} d={p} className="draw-ink" /> : <path key={i} d={p} className="draw-line" />))}
      {onDown && <path d={hitPath(d)} className="draw-hit nopan nodrag" data-draw-id={d.id} onPointerDown={onDown} />}
    </g>
  );
}

// Recuadro de lo elegido, medido sobre lo que se ha pintado.
function SelectionBox({ id }: { id: string }) {
  const ref = useRef<SVGRectElement>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const g = ref.current?.ownerSVGElement?.querySelector<SVGGElement>(`[data-draw="${CSS.escape(id)}"]`);
    const b = g?.getBBox() ?? null;
    if (!b) return setBox(null);
    if (!box || b.x !== box.x || b.y !== box.y || b.width !== box.width || b.height !== box.height) setBox(b);
  });
  const pad = 8;
  return box ? (
    <rect ref={ref} className="draw-selection" x={box.x - pad} y={box.y - pad} width={box.width + pad * 2} height={box.height + pad * 2} rx={6} />
  ) : (
    <rect ref={ref} width={0} height={0} fill="none" />
  );
}

export function DrawLayer({ drawings, draft, selected, erasing, typing, onShapeDown, onTextEdit, onTyping, onTypingDone }: LayerProps) {
  return (
    <>
      <svg className="draw-layer" width={1} height={1} aria-hidden>
        {drawings.map((d) =>
          typing?.id === d.id ? null : (
            <Shape key={d.id} d={d} faded={erasing.has(d.id)} onDown={(e) => onShapeDown(e, d.id)} onEdit={() => onTextEdit(d)} />
          ),
        )}
        {draft && <Shape d={draft} />}
        {selected && !typing && <SelectionBox id={selected} />}
      </svg>
      {typing && (
        <textarea
          className={`draw-textarea nopan nodrag nowheel draw-c-${typing.color}`}
          style={{ left: typing.x, top: typing.y, fontSize: fontSize(typing.size) }}
          value={typing.text}
          rows={Math.max(1, typing.text.split('\n').length)}
          placeholder={t('Escribe…')}
          autoFocus
          spellCheck={false}
          onChange={(e) => onTyping(e.target.value)}
          onBlur={onTypingDone}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
      )}
    </>
  );
}

// ── Barra ────────────────────────────────────────────────────────────

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const TOOLS: { id: Tool; label: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Seleccionar', icon: icon(<path d="M6.5 4 18 10.2l-5.3 1.7-2.3 5.4z" />) },
  { id: 'pen', label: 'Lápiz', icon: icon(<path d="M4.5 19.5l1-4.2L16 4.8l3.2 3.2L8.7 18.5zM14 6.8l3.2 3.2" />) },
  { id: 'line', label: 'Línea', icon: icon(<path d="M5 19 19 5" />) },
  { id: 'arrow', label: 'Flecha', icon: icon(<path d="M5 19 19 5M10.5 5H19v8.5" />) },
  { id: 'rect', label: 'Rectángulo', icon: icon(<rect x="4" y="6" width="16" height="12" rx="2" />) },
  { id: 'ellipse', label: 'Elipse', icon: icon(<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />) },
  { id: 'text', label: 'Texto', icon: icon(<path d="M6 6.5h12M12 6.5V19" />) },
  { id: 'eraser', label: 'Goma', icon: icon(<path d="M9 19.5h10M6 15.5l8.6-8.6a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L11 18.5H9z" />) },
];

const COLOR_NAMES: Record<DrawColor, string> = { ink: 'Tinta', accent: 'Acento', red: 'Rojo', orange: 'Naranja', green: 'Verde', blue: 'Azul' };
const SIZE_NAMES: Record<DrawSize, string> = { 1: 'Fino', 2: 'Medio', 3: 'Grueso' };

type BarProps = {
  tool: Tool;
  color: DrawColor;
  size: DrawSize;
  showStyle: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (t: Tool) => void;
  onColor: (c: DrawColor) => void;
  onSize: (s: DrawSize) => void;
  onUndo: () => void;
  onRedo: () => void;
};

export function DrawBar({ tool, color, size, showStyle, canUndo, canRedo, onTool, onColor, onSize, onUndo, onRedo }: BarProps) {
  return (
    <div className="draw-ui">
      <nav className="draw-rail surface-2" aria-label={t('Dibujar')}>
        {TOOLS.map((x) => (
          <button key={x.id} className={tool === x.id ? 'is-on' : ''} title={t(x.label)} aria-label={t(x.label)} aria-pressed={tool === x.id} onClick={() => onTool(x.id)}>
            {x.icon}
          </button>
        ))}
        <span className="draw-rail-sep" />
        <button title={`${t('Deshacer')} (Ctrl Z)`} aria-label={t('Deshacer')} disabled={!canUndo} onClick={onUndo}>
          {icon(<path d="M9 13.5 4.5 9 9 4.5M4.5 9h9.5a5.5 5.5 0 0 1 0 11H11" />)}
        </button>
        <button title={`${t('Rehacer')} (Ctrl ⇧ Z)`} aria-label={t('Rehacer')} disabled={!canRedo} onClick={onRedo}>
          {icon(<path d="M15 13.5 19.5 9 15 4.5M19.5 9H10a5.5 5.5 0 0 0 0 11h3" />)}
        </button>
      </nav>
      {showStyle && (
        <div className="draw-style surface-2">
          {DRAW_COLORS.map((c) => (
            <button key={c} className={`draw-swatch draw-c-${c}${color === c ? ' is-on' : ''}`} title={t(COLOR_NAMES[c])} aria-label={t(COLOR_NAMES[c])} aria-pressed={color === c} onClick={() => onColor(c)}>
              <span />
            </button>
          ))}
          <span className="draw-style-sep" />
          {DRAW_SIZES.map((s) => (
            <button key={s} className={`draw-width${size === s ? ' is-on' : ''}`} title={t(SIZE_NAMES[s])} aria-label={t(SIZE_NAMES[s])} aria-pressed={size === s} onClick={() => onSize(s)}>
              <span style={{ width: Math.max(4, penWidth(s) * 0.9), height: Math.max(4, penWidth(s) * 0.9) }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
