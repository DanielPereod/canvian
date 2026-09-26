import type { NoteRow } from '../api';

// Mapa de secciones: las zonas forman un árbol (una zona dibujada dentro de
// otra es su subsección) y cada nivel se reparte la pantalla en formas
// orgánicas, como un mapa de territorios.

export type Rect = { x: number; y: number; w: number; h: number };
export type Section = {
  id: string;
  title: string;
  rect: Rect;
  children: Section[];
  // Notas dentro, contando las de las subsecciones.
  total: number;
  // Títulos de algunas notas propias, para asomarse sin entrar.
  peek: string[];
  // «Sin sección»: notas sueltas del nivel, no una zona de verdad.
  loose?: boolean;
};

export type Item = { id: string; kind: string; title: string | null; rect: Rect };

const area = (r: Rect) => r.w * r.h;
const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const contains = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const bounds = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
};

export function buildSections(items: Item[]): Section[] {
  const zones = items.filter((i) => i.kind === 'zone').sort((a, b) => area(b.rect) - area(a.rect));
  // La zona más pequeña que contiene el centro de algo es su madre.
  const parentOf = (r: Rect, self?: string) => {
    let best: Item | null = null;
    for (const z of zones) {
      if (z.id === self || area(z.rect) <= (self ? area(r) : 0) || !contains(z.rect, mid(r))) continue;
      if (!best || area(z.rect) < area(best.rect)) best = z;
    }
    return best?.id ?? null;
  };
  const kids = new Map<string | null, Item[]>();
  const notesIn = new Map<string | null, Item[]>();
  for (const z of zones) {
    const p = parentOf(z.rect, z.id);
    kids.set(p, [...(kids.get(p) ?? []), z]);
  }
  for (const n of items) {
    if (n.kind === 'zone') continue;
    const p = parentOf(n.rect);
    notesIn.set(p, [...(notesIn.get(p) ?? []), n]);
  }
  const peekOf = (ns: Item[]) => ns.map((n) => n.title).filter((t): t is string => !!t).slice(0, 3);

  const level = (parent: string | null, parentTitle: string | null): Section[] => {
    const out: Section[] = (kids.get(parent) ?? []).map((z) => {
      const children = level(z.id, z.title);
      const own = notesIn.get(z.id) ?? [];
      return {
        id: z.id,
        title: z.title || 'Sin nombre',
        rect: z.rect,
        // Una sección sin subsecciones no necesita la celda de sus propias notas.
        children: children.every((c) => c.loose) ? [] : children,
        total: own.length + children.reduce((t, c) => t + (c.loose ? 0 : c.total), 0),
        peek: peekOf(own),
      };
    });
    const own = notesIn.get(parent) ?? [];
    if (own.length && out.length)
      out.push({
        id: `loose:${parent ?? 'root'}`,
        title: parentTitle ? `Resto de ${parentTitle}` : 'Sin sección',
        rect: bounds(own.map((n) => n.rect)),
        children: [],
        total: own.length,
        peek: peekOf(own),
        loose: true,
      });
    return out;
  };
  return level(null, null);
}

export function itemsFrom(rows: { row: NoteRow; rect: Rect }[]): Item[] {
  return rows.map(({ row, rect }) => ({ id: row.id, kind: row.kind, title: row.title, rect }));
}

/* ── Geometría: un diagrama de potencia recortado a la pantalla ─────────── */

type P = { x: number; y: number };

// Sutherland–Hodgman contra el semiplano a·p ≤ b.
function clip(poly: P[], ax: number, ay: number, b: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const fp = ax * p.x + ay * p.y - b;
    const fq = ax * q.x + ay * q.y - b;
    if (fp <= 0) out.push(p);
    if (fp * fq < 0) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

function centroid(poly: P[]): P {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-6) return poly[0] ?? { x: 0, y: 0 };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// Ruido suave y estable por sección, para que los bordes parezcan a mano.
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// Subdivide los lados, los ondula un poco y redondea las esquinas (Chaikin).
function organic(poly: P[], seed: number): P[] {
  let pts: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.max(1, Math.round(len / 70));
    const nx = -(q.y - p.y) / (len || 1);
    const ny = (q.x - p.x) / (len || 1);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const wob = k === 0 ? 0 : Math.sin((seed * 13 + i * 3.7 + t * 5.1) * 2.3) * Math.min(7, len / 24);
      pts.push({ x: p.x + (q.x - p.x) * t + nx * wob, y: p.y + (q.y - p.y) * t + ny * wob });
    }
  }
  for (let it = 0; it < 4; it++) {
    const next: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 }, { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    pts = next;
  }
  return pts;
}

export type Cell = { section: Section; d: string; center: P; box: Rect; area: number };

// Reparte el rectángulo `frame` entre las secciones. Cada una conserva su sitio
// relativo en el lienzo y ocupa más cuantas más notas tiene.
export function layoutCells(sections: Section[], frame: Rect, gap = 16): Cell[] {
  if (!sections.length) return [];
  const all = bounds(sections.map((s) => s.rect));
  // Semillas: los centros de las zonas llevados al marco, sin salirse del borde.
  const pad = 0.14;
  let seeds: P[] = sections.map((s, i) => {
    const c = mid(s.rect);
    const u = all.w ? (c.x - all.x) / all.w : 0.5;
    const v = all.h ? (c.y - all.y) / all.h : 0.5;
    const j = (hash(s.id + i) - 0.5) * 0.02;
    return { x: frame.x + frame.w * (pad + (1 - 2 * pad) * u + j), y: frame.y + frame.h * (pad + (1 - 2 * pad) * v - j) };
  });
  const maxT = Math.max(...sections.map((s) => s.total), 1);
  const share = sections.map((s) => 0.35 + 0.65 * Math.sqrt(s.total / maxT));

  const rect: P[] = [
    { x: frame.x, y: frame.y },
    { x: frame.x + frame.w, y: frame.y },
    { x: frame.x + frame.w, y: frame.y + frame.h },
    { x: frame.x, y: frame.y + frame.h },
  ];
  const cellsFor = (pts: P[], inset: number) => {
    let near = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) near = Math.min(near, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    if (!isFinite(near)) near = Math.max(frame.w, frame.h);
    const w = share.map((s) => s * near * near * 0.3);
    return pts.map((p, i) => {
      let poly = rect;
      for (let j = 0; j < pts.length && poly.length; j++) {
        if (j === i) continue;
        const q = pts[j];
        const ax = 2 * (q.x - p.x);
        const ay = 2 * (q.y - p.y);
        const b = q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y + w[i] - w[j];
        poly = clip(poly, ax, ay, b - (inset / 2) * Math.hypot(ax, ay));
      }
      return poly;
    });
  };
  // Dos pasadas de relajación: formas más parejas sin perder la disposición.
  for (let it = 0; it < 2; it++) {
    const polys = cellsFor(seeds, 0);
    seeds = seeds.map((s, i) => {
      const c = polys[i].length > 2 ? centroid(polys[i]) : s;
      return { x: s.x * 0.5 + c.x * 0.5, y: s.y * 0.5 + c.y * 0.5 };
    });
  }
  const polys = cellsFor(seeds, gap).map((poly) =>
    // El borde de la pantalla también deja aire.
    [
      [1, 0, frame.x + frame.w - gap / 2],
      [-1, 0, -(frame.x + gap / 2)],
      [0, 1, frame.y + frame.h - gap / 2],
      [0, -1, -(frame.y + gap / 2)],
    ].reduce((p, [ax, ay, b]) => (p.length ? clip(p, ax, ay, b) : p), poly),
  );

  return sections.flatMap((section, i) => {
    const poly = polys[i];
    if (poly.length < 3) return [];
    const pts = organic(poly, hash(section.id));
    const box = bounds(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
    const d = 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
    return [{ section, d, center: centroid(poly), box, area: area(box) }];
  });
}

// Busca una sección por id y devuelve el camino desde la raíz.
export function pathTo(sections: Section[], id: string): Section[] | null {
  for (const s of sections) {
    if (s.id === id) return [s];
    const sub = pathTo(s.children, id);
    if (sub) return [s, ...sub];
  }
  return null;
}

// El camino a la sección más honda que contiene un punto del lienzo.
export function pathAt(sections: Section[], p: P): Section[] {
  for (const s of sections) {
    if (s.loose || !contains(s.rect, p)) continue;
    return [s, ...pathAt(s.children, p)];
  }
  return [];
}
