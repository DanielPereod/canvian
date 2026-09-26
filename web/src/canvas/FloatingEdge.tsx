import { Position, getBezierPath, getStraightPath, useInternalNode, useStore, type EdgeProps, type InternalNode } from '@xyflow/react';
import { useCanvasActions } from './context';
import { useExperiments } from '../lab/experiments';
import { CONSTELLATION_ZOOM } from './Constellation';

// Los enlaces salen del borde más cercano de cada nota en vez de un asa fija
// y se dibujan como tallos: crecen al aparecer y dejan pasar un pulso de luz
// cuando los señalas.
function box(node: InternalNode) {
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function borderPoint(from: InternalNode, to: InternalNode) {
  const a = box(from);
  const b = box(to);
  const w2 = a.w / 2;
  const h2 = a.h / 2;
  const xx1 = (b.cx - a.cx) / (2 * w2) - (b.cy - a.cy) / (2 * h2);
  const yy1 = (b.cx - a.cx) / (2 * w2) + (b.cy - a.cy) / (2 * h2);
  const k = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const x = w2 * (k * xx1 + k * yy1) + a.cx;
  const y = h2 * (-k * xx1 + k * yy1) + a.cy;
  const eps = 1;
  const side =
    x <= a.x + eps ? Position.Left : x >= a.x + a.w - eps ? Position.Right : y <= a.y + eps ? Position.Top : Position.Bottom;
  return { x, y, side };
}

export function FloatingEdge({ id, source, target }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  const { lit } = useCanvasActions();
  const { constelacion } = useExperiments();
  const far = useStore((st) => st.transform[2] < CONSTELLATION_ZOOM);
  if (!s || !t) return null;
  const dim = lit && !(lit.has(source) && lit.has(target)) ? ' shadowed' : '';
  // En modo constelación los enlaces son líneas rectas entre estrellas (centros).
  if (constelacion && far) {
    const a = box(s);
    const b = box(t);
    const [line] = getStraightPath({ sourceX: a.cx, sourceY: a.cy, targetX: b.cx, targetY: b.cy });
    return (
      <>
        <path id={id} className={`react-flow__edge-path stem star-line${dim}`} d={line} pathLength={1} />
        <path className="react-flow__edge-interaction" d={line} fill="none" strokeOpacity={0} strokeWidth={18} />
      </>
    );
  }
  const from = borderPoint(s, t);
  const to = borderPoint(t, s);
  const [path] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: from.side,
    targetX: to.x,
    targetY: to.y,
    targetPosition: to.side,
    curvature: 0.45,
  });
  return (
    <>
      <path id={id} className={`react-flow__edge-path stem${dim}`} d={path} pathLength={1} />
      <path className={`stem-pulse${dim}`} d={path} pathLength={1} />
      <path className="react-flow__edge-interaction" d={path} fill="none" strokeOpacity={0} strokeWidth={18} />
    </>
  );
}
