import { BaseEdge, Position, getBezierPath, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react';

// Los enlaces salen del borde más cercano de cada nota en vez de un asa fija,
// así se ven bien muevas las notas como las muevas.
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

export function FloatingEdge({ id, source, target, style, label, selected }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const from = borderPoint(s, t);
  const to = borderPoint(t, s);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: from.side,
    targetX: to.x,
    targetY: to.y,
    targetPosition: to.side,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      className={selected ? 'selected' : undefined}
      interactionWidth={16}
    />
  );
}
