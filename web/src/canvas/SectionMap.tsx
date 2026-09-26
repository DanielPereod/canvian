import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { layoutCells, type Cell, type Section } from './sections';

// Experimento «Secciones»: de lejos, el lienzo se ve como un mapa de
// territorios que ocupan toda la pantalla. Acercarte a uno (rueda o clic)
// abre sus subsecciones; cuando ya no hay más, aterrizas en sus notas.

const DIVE_MS = 520;
const RISE_MS = 300;
const WHEEL_STEP = 40;

type Props = {
  sections: Section[];
  // Camino por el que se entra: se muestra el nivel del último.
  start: Section[];
  onLand: (section: Section) => void;
  onDismiss: () => void;
};

function useFrame() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

const hueOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function SectionMap({ sections, start, onLand, onDismiss }: Props) {
  const { w, h } = useFrame();
  // Las secciones del camino se buscan de nuevo en el árbol actual por id.
  const [stackIds, setStackIds] = useState(() => start.slice(0, -1).map((s) => s.id));
  const [came, setCame] = useState<string | null>(() => start.at(-1)?.id ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [motion, setMotion] = useState<{ kind: 'dive'; cell: Cell } | { kind: 'rise' } | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Al abrirse, la rueda espera un poco: el mismo gesto que alejó el lienzo no
  // debe seguir actuando sobre el mapa.
  const wheel = useRef({ sum: 0, last: 0, lockUntil: performance.now() + 500 });

  const stack = useMemo(() => {
    const out: Section[] = [];
    let level = sections;
    for (const id of stackIds) {
      const s = level.find((x) => x.id === id);
      if (!s) break;
      out.push(s);
      level = s.children;
    }
    return out;
  }, [sections, stackIds]);
  const level = stack.at(-1)?.children ?? sections;
  const frame = useMemo(() => ({ x: 0, y: 64, w, h: h - 64 - 84 }), [w, h]);
  const cells = useMemo(() => layoutCells(level, frame), [level, frame]);

  const enter = (cell: Cell) => {
    if (motion) return;
    setMotion({ kind: 'dive', cell });
    setTimeout(() => {
      if (cell.section.children.length) {
        setStackIds((ids) => [...ids, cell.section.id]);
        setCame(null);
        setMotion(null);
      } else {
        setLeaving(true);
        onLand(cell.section);
      }
    }, DIVE_MS);
  };

  const up = (to = stack.length - 1) => {
    if (motion) return;
    if (!stack.length) return onDismiss();
    setMotion({ kind: 'rise' });
    setTimeout(() => {
      setCame(stack[to]?.id ?? null);
      setStackIds((ids) => ids.slice(0, Math.max(0, to)));
      setMotion(null);
    }, RISE_MS);
  };

  const hovered = cells.find((c) => c.section.id === hover) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        up();
      } else if (e.key === 'Enter' && hovered) {
        e.preventDefault();
        e.stopPropagation();
        enter(hovered);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // La rueda acumula hasta un umbral y luego se bloquea un momento, para que la
  // inercia del trackpad no atraviese varios niveles de golpe.
  const onWheel = (e: React.WheelEvent) => {
    const now = performance.now();
    const st = wheel.current;
    if (now < st.lockUntil) {
      st.lockUntil = Math.max(st.lockUntil, now + 120);
      return;
    }
    if (now - st.last > 250) st.sum = 0;
    st.last = now;
    st.sum += e.deltaY;
    if (st.sum <= -WHEEL_STEP) {
      st.sum = 0;
      const target =
        hovered ??
        cells.find((c) => {
          const b = c.box;
          return e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h;
        });
      if (target) {
        st.lockUntil = now + DIVE_MS + 250;
        enter(target);
      }
    } else if (st.sum >= WHEEL_STEP && stack.length) {
      // En la raíz, alejarse no hace nada; para volver al lienzo, Esc.
      st.sum = 0;
      st.lockUntil = now + RISE_MS + 250;
      up();
    }
  };

  const diveStyle = (cell: Cell): CSSProperties | undefined => {
    if (motion?.kind !== 'dive' || motion.cell !== cell) return undefined;
    const k = Math.max(w / cell.box.w, h / cell.box.h) * 1.15;
    const dx = w / 2 - (cell.box.x + cell.box.w / 2);
    const dy = h / 2 - (cell.box.y + cell.box.h / 2);
    return { transform: `translate(${dx}px, ${dy}px) scale(${k})` };
  };

  return (
    <div
      className={`smap${motion ? ` is-${motion.kind}` : ''}${leaving ? ' is-leaving' : ''}`}
      onWheel={onWheel}
      onMouseLeave={() => setHover(null)}
    >
      <nav className="smap-crumbs">
        <button className={stack.length ? 'smap-crumb' : 'smap-crumb current'} onClick={() => stack.length && up(0)}>
          Todo
        </button>
        {stack.map((s, i) => (
          <span key={s.id} className="smap-crumb-wrap">
            <span className="smap-sep" aria-hidden="true">
              ›
            </span>
            <button className={i === stack.length - 1 ? 'smap-crumb current' : 'smap-crumb'} onClick={() => i < stack.length - 1 && up(i + 1)}>
              {s.title}
            </button>
          </span>
        ))}
      </nav>

      <svg className="smap-svg" width={w} height={h} key={stackIds.join('/')}>
        {cells.map((cell, i) => {
          const s = cell.section;
          const hue = hueOf(s.id);
          const size = Math.max(18, Math.min(56, Math.sqrt(cell.area) / 9));
          const small = Math.sqrt(cell.area) < 220;
          const peek = s.children.length ? s.children.map((c) => c.title) : s.peek;
          const diving = motion?.kind === 'dive' && motion.cell === cell;
          return (
            <g
              key={s.id}
              className={`smap-cell${s.loose ? ' loose' : ''}${hover === s.id ? ' hover' : ''}${came === s.id ? ' came' : ''}${diving ? ' diving' : ''}`}
              style={{ '--i': i, '--hue': hue, ...diveStyle(cell) } as CSSProperties}
              onMouseEnter={() => setHover(s.id)}
              onClick={() => enter(cell)}
            >
              <path d={cell.d} />
              <g className="smap-label" transform={`translate(${cell.center.x} ${cell.center.y})`}>
                <text className="smap-title" y={small ? 0 : -size * 0.35} style={{ fontSize: size }}>
                  {s.title}
                </text>
                <text className="smap-meta" y={small ? 20 : size * 0.35 + 8}>
                  {plural(s.total, 'nota', 'notas')}
                  {s.children.length ? ` · ${plural(s.children.filter((c) => !c.loose).length, 'sección', 'secciones')}` : ''}
                </text>
                {!small &&
                  peek.slice(0, 3).map((t, k) => (
                    <text key={k} className="smap-peek" y={size * 0.35 + 34 + k * 19}>
                      {t.length > 34 ? t.slice(0, 33) + '…' : t}
                    </text>
                  ))}
              </g>
            </g>
          );
        })}
      </svg>

      <p className="smap-hint meta">
        {stack.length ? 'Rueda o clic para entrar · rueda atrás o Esc para salir' : 'Rueda o clic para entrar en una sección · Esc para volver al lienzo'}
      </p>
    </div>
  );
}
