import { getStroke } from 'perfect-freehand';
import rough from 'roughjs';

// Lo dibujado a mano encima de un lienzo, al estilo de Excalidraw: trazos
// libres, líneas, flechas, rectángulos, elipses y textos sueltos. Se guarda en
// el mismo JSON Canvas de la nota, en `drawings`, con coordenadas del lienzo,
// así que se mueve y se acerca con él.

export const DRAW_COLORS = ['ink', 'accent', 'red', 'orange', 'green', 'blue'] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];
export type DrawSize = 1 | 2 | 3;
export const DRAW_SIZES: DrawSize[] = [1, 2, 3];

type Style = { color: DrawColor; size: DrawSize };
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';

export type Drawing =
  // pts: x, y y presión, de tres en tres. `pr`: la presión es la del lápiz.
  | ({ id: string; kind: 'pen'; pts: number[]; pr?: 1 } & Style)
  | ({ id: string; kind: ShapeKind; x1: number; y1: number; x2: number; y2: number; seed: number } & Style)
  | ({ id: string; kind: 'text'; x: number; y: number; text: string } & Style);

export type Tool = 'select' | 'pen' | ShapeKind | 'text' | 'eraser';

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

// Lo que llega del servidor se revisa: lo que no se entiende se descarta.
export function cleanDrawings(v: unknown): Drawing[] {
  if (!Array.isArray(v)) return [];
  return v.filter((d): d is Drawing => {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') return false;
    if (!DRAW_COLORS.includes(d.color) || !DRAW_SIZES.includes(d.size)) return false;
    if (d.kind === 'pen') return Array.isArray(d.pts) && d.pts.length >= 3 && d.pts.every(num);
    if (d.kind === 'text') return num(d.x) && num(d.y) && typeof d.text === 'string';
    return ['line', 'arrow', 'rect', 'ellipse'].includes(d.kind) && [d.x1, d.y1, d.x2, d.y2, d.seed].every(num);
  });
}

// Grosor de cada tamaño: trazo de las formas, diámetro del lápiz y letra.
export const strokeWidth = (s: DrawSize) => [0, 1.6, 3, 5.5][s];
export const penWidth = (s: DrawSize) => [0, 4, 8, 15][s];
export const fontSize = (s: DrawSize) => [0, 18, 26, 40][s];

const r1 = (n: number) => Math.round(n * 10) / 10;

// Al guardar, sin decimales de más: el lienzo entero va en un solo campo.
export function tidy(d: Drawing): Drawing {
  if (d.kind === 'pen') return { ...d, pts: d.pts.map((n, i) => (i % 3 === 2 ? Math.round(n * 100) / 100 : r1(n))) };
  if (d.kind === 'text') return { ...d, x: r1(d.x), y: r1(d.y) };
  return { ...d, x1: r1(d.x1), y1: r1(d.y1), x2: r1(d.x2), y2: r1(d.y2) };
}

export function translate(d: Drawing, dx: number, dy: number): Drawing {
  if (d.kind === 'pen') return { ...d, pts: d.pts.map((n, i) => (i % 3 === 0 ? n + dx : i % 3 === 1 ? n + dy : n)) };
  if (d.kind === 'text') return { ...d, x: d.x + dx, y: d.y + dy };
  return { ...d, x1: d.x1 + dx, y1: d.y1 + dy, x2: d.x2 + dx, y2: d.y2 + dy };
}

// ── Trazo libre: perfect-freehand da el contorno de una pincelada ─────

function outline(points: number[][]): string {
  if (!points.length) return '';
  const avg = (a: number, b: number) => (a + b) / 2;
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)} Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    d += `${x0.toFixed(2)},${y0.toFixed(2)} ${avg(x0, x1).toFixed(2)},${avg(y0, y1).toFixed(2)} `;
  }
  return d + 'Z';
}

function penPoints(pts: number[]) {
  const out: number[][] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

// ── Formas: rough.js les da el aire de dibujo a mano ──────────────────

const gen = rough.generator();
const cache = new WeakMap<Drawing, string[]>();

function arrowHead(d: { x1: number; y1: number; x2: number; y2: number; size: DrawSize }) {
  const a = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
  const len = Math.min(10 + d.size * 5, Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * 0.45);
  const wing = (s: number): [number, number] => [d.x2 - len * Math.cos(a + s * 0.5), d.y2 - len * Math.sin(a + s * 0.5)];
  return [wing(1), [d.x2, d.y2] as [number, number], wing(-1)];
}

// Los caminos SVG que se pintan de una forma (o el contorno de un trazo libre).
export function drawingPaths(d: Drawing): string[] {
  const hit = cache.get(d);
  if (hit) return hit;
  let paths: string[] = [];
  if (d.kind === 'pen') {
    paths = [
      outline(
        getStroke(penPoints(d.pts), { size: penWidth(d.size), thinning: 0.55, smoothing: 0.5, streamline: 0.45, simulatePressure: !d.pr, last: true }),
      ),
    ];
  } else if (d.kind !== 'text') {
    const o = { seed: d.seed, roughness: 1, bowing: 1, strokeWidth: strokeWidth(d.size), stroke: 'currentColor' };
    const x = Math.min(d.x1, d.x2);
    const y = Math.min(d.y1, d.y2);
    const w = Math.abs(d.x2 - d.x1);
    const h = Math.abs(d.y2 - d.y1);
    const drawables =
      d.kind === 'rect'
        ? [gen.rectangle(x, y, w, h, o)]
        : d.kind === 'ellipse'
          ? [gen.ellipse(x + w / 2, y + h / 2, w, h, o)]
          : d.kind === 'line'
            ? [gen.line(d.x1, d.y1, d.x2, d.y2, o)]
            : [gen.line(d.x1, d.y1, d.x2, d.y2, o), gen.linearPath(arrowHead(d), o)];
    paths = drawables.flatMap((dr) => gen.toPaths(dr).map((p) => p.d));
  }
  cache.set(d, paths);
  return paths;
}

// Un camino limpio por donde pasa la forma, para poder tocarla y borrarla.
export function hitPath(d: Drawing): string {
  if (d.kind === 'pen') {
    const p = penPoints(d.pts);
    return p.length === 1 ? `M${p[0][0]},${p[0][1]}h0.1` : 'M' + p.map(([x, y]) => `${x},${y}`).join('L');
  }
  if (d.kind === 'text') return '';
  const x = Math.min(d.x1, d.x2);
  const y = Math.min(d.y1, d.y2);
  const w = Math.abs(d.x2 - d.x1);
  const h = Math.abs(d.y2 - d.y1);
  if (d.kind === 'rect') return `M${x},${y}h${w}v${h}h${-w}Z`;
  if (d.kind === 'ellipse') return `M${x},${y + h / 2}a${w / 2},${h / 2} 0 1 0 ${w},0a${w / 2},${h / 2} 0 1 0 ${-w},0`;
  const line = `M${d.x1},${d.y1}L${d.x2},${d.y2}`;
  if (d.kind === 'line') return line;
  const [a, b, c] = arrowHead(d);
  return `${line}M${a[0]},${a[1]}L${b[0]},${b[1]}L${c[0]},${c[1]}`;
}

// Con mayúsculas: líneas a saltos de 15° y formas con los lados iguales.
export function constrain(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (kind === 'line' || kind === 'arrow') {
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return { x2: x1 + len * Math.cos(a), y2: y1 + len * Math.sin(a) };
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x2: x1 + Math.sign(dx || 1) * s, y2: y1 + Math.sign(dy || 1) * s };
}
