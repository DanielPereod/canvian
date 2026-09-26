import { bounds, type MapNode } from './sections';

// Motor del mapa de secciones. Cada nivel es un diagrama de potencia (un
// Voronoi con pesos) que se recalcula en cada fotograma: los pesos se ajustan
// hasta que cada celda ocupa el área que le toca por importancia, y las
// semillas siguen a sus centros. El resultado se mueve como un fluido: si una
// celda crece (porque te acercas o la señalas), las vecinas ceden sitio.

type P = { x: number; y: number };

/* ── Geometría ─────────────────────────────────────────────────────────── */

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

function polyArea(poly: P[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function centroid(poly: P[]): P {
  const a = polyArea(poly);
  if (Math.abs(a) < 1e-6) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function inside(poly: P[], p: P) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

// Recorta un polígono contra otro convexo, dejando `inset` de margen.
function clipConvex(poly: P[], frame: P[], inset: number) {
  const ccw = polyArea(frame) > 0;
  let out = poly;
  for (let i = 0; i < frame.length && out.length; i++) {
    const p = frame[i];
    const q = frame[(i + 1) % frame.length];
    // Normal hacia fuera del marco.
    let nx = q.y - p.y;
    let ny = -(q.x - p.x);
    if (!ccw) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    out = clip(out, nx, ny, nx * p.x + ny * p.y - inset);
  }
  return out;
}

const bbox = (poly: P[]) => {
  const b = bounds(poly.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })));
  return b;
};

// Bordes vivos: un campo de ruido suave, el mismo para todas las celdas, así
// dos vecinas ondulan juntas y el surco entre ellas se mantiene.
function warp(p: P, t: number, amp: number): P {
  return {
    x: p.x + amp * Math.sin(p.x * 0.011 + t * 0.45 + 1.3 * Math.sin(p.y * 0.007 + t * 0.2)),
    y: p.y + amp * Math.sin(p.y * 0.013 - t * 0.38 + 1.1 * Math.sin(p.x * 0.009 - t * 0.17)),
  };
}

function organicPath(poly: P[], t: number, amp: number) {
  let pts: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const steps = Math.max(1, Math.round(Math.hypot(q.x - p.x, q.y - p.y) / 46));
    for (let k = 0; k < steps; k++) pts.push(warp({ x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps }, t, amp));
  }
  for (let it = 0; it < 3; it++) {
    const next: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 }, { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    pts = next;
  }
  let d = '';
  for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + pts[i].x.toFixed(1) + ',' + pts[i].y.toFixed(1);
  return d + 'Z';
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
};
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const smooth = (a: number, b: number, x: number) => ease((x - a) / (b - a));

/* ── Simulación de un nivel ───────────────────────────────────────────── */

export type Cell = {
  node: MapNode;
  anchor: P;
  seed: P;
  w: number;
  poly: P[];
  drawn: P[];
  area: number;
  center: P;
  alive: number;
  // Zoom sobre esta celda: 0 en reposo, 1 cuando ya ocupa toda la pantalla.
  s: number;
  sTarget: number;
  phase: number;
  hue: number;
};

const GAP = 12;

export class Fluid {
  node: MapNode;
  lens: MapLens = { lit: null, hide: false, memoria: false };
  cells: Cell[] = [];
  frame: P[] = [];
  hue: number;

  constructor(node: MapNode, frame: P[], hue: number) {
    this.node = node;
    this.frame = frame;
    this.hue = hue;
    this.setNode(node);
  }

  setNode(node: MapNode) {
    this.node = node;
    const old = new Map(this.cells.map((c) => [c.node.id, c]));
    const all = bounds(node.children.map((c) => c.rect));
    const total = Math.abs(polyArea(this.frame));
    this.cells = node.children.map((child) => {
      const u = (child.rect.x + child.rect.w / 2 - all.x) / all.w;
      const v = (child.rect.y + child.rect.h / 2 - all.y) / all.h;
      const anchor = { x: isFinite(u) ? u : 0.5, y: isFinite(v) ? v : 0.5 };
      const prev = old.get(child.id);
      if (prev) return { ...prev, node: child, anchor };
      const h = hash(child.id);
      return {
        node: child,
        anchor,
        seed: this.place(anchor, h),
        w: total / Math.max(1, node.children.length) / Math.PI / 3,
        poly: [],
        drawn: [],
        area: 0,
        center: this.place(anchor, h),
        alive: 0,
        s: 0,
        sTarget: 0,
        phase: h * Math.PI * 2,
        hue: child.kind === 'note' ? (this.hue + (h - 0.5) * 36 + 360) % 360 : Math.floor(h * 360),
      };
    });
  }

  // Lleva un punto de la disposición del lienzo (0–1) dentro del marco.
  place(a: P, jitter = 0): P {
    const b = bbox(this.frame);
    const pad = 0.14;
    let p = {
      x: b.x + b.w * (pad + (1 - 2 * pad) * a.x) + (jitter - 0.5) * 6,
      y: b.y + b.h * (pad + (1 - 2 * pad) * a.y) - (jitter - 0.5) * 6,
    };
    const c = centroid(this.frame);
    for (let i = 0; i < 12 && !inside(this.frame, p); i++) p = { x: (p.x + c.x) / 2, y: (p.y + c.y) / 2 };
    return p;
  }

  // Área que le toca a cada celda, de 0 a 1.
  shares(t: number, hover: string | null) {
    const { lit, hide } = this.lens;
    const base = this.cells.map(
      (c) =>
        Math.pow(c.node.importance, 0.75) *
        (1 + 0.025 * Math.sin(t * 0.55 + c.phase)) *
        (c.node.id === hover ? 1.08 : 1) *
        (hide && lit && !lit.has(c.node.id) ? 0.04 : 1),
    );
    const zoomed = this.cells.reduce<Cell | null>((m, c) => (c.s > (m?.s ?? 0.001) ? c : m), null);
    const sum = base.reduce((a, b) => a + b, 0) || 1;
    const frac = base.map((b) => b / sum);
    if (zoomed) {
      const i = this.cells.indexOf(zoomed);
      const f = frac[i] + (0.985 - frac[i]) * ease(Math.min(1, zoomed.s));
      const rest = 1 - frac[i];
      for (let j = 0; j < frac.length; j++) frac[j] = j === i ? f : rest > 0 ? (frac[j] / rest) * (1 - f) : 0;
    }
    return frac;
  }

  step(t: number, hover: string | null) {
    const n = this.cells.length;
    if (!n) return;
    const total = Math.abs(polyArea(this.frame));
    const frac = this.shares(t, hover);
    const base = this.frame;
    for (let i = 0; i < n; i++) {
      const a = this.cells[i];
      let poly = base;
      let drawn = base;
      for (let j = 0; j < n && poly.length; j++) {
        if (j === i) continue;
        const b = this.cells[j];
        const ax = 2 * (b.seed.x - a.seed.x);
        const ay = 2 * (b.seed.y - a.seed.y);
        const len = Math.hypot(ax, ay);
        if (len < 1e-6) continue;
        const k = b.seed.x * b.seed.x + b.seed.y * b.seed.y - a.seed.x * a.seed.x - a.seed.y * a.seed.y + a.w - b.w;
        poly = clip(poly, ax, ay, k);
        if (drawn.length) drawn = clip(drawn, ax, ay, k - (GAP / 2) * len);
      }
      a.poly = poly;
      a.drawn = drawn.length > 2 ? clipConvex(drawn, base, GAP / 2) : [];
      a.area = poly.length > 2 ? Math.abs(polyArea(poly)) : 0;
      a.center = a.drawn.length > 2 ? centroid(a.drawn) : a.seed;
    }
    // Pesos: cada celda empuja o cede hasta ocupar su parte.
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const c = this.cells[i];
      c.w += (0.3 * (frac[i] * total - c.area)) / Math.PI;
      mean += c.w;
    }
    mean /= n;
    for (const c of this.cells) c.w -= mean;
    // Semillas: hacia su centro de masas y, un poco, hacia su sitio en el lienzo.
    for (const c of this.cells) {
      const home = this.place(c.anchor);
      const cm = c.poly.length > 2 ? centroid(c.poly) : home;
      c.seed = { x: c.seed.x + 0.07 * (cm.x - c.seed.x) + 0.01 * (home.x - c.seed.x), y: c.seed.y + 0.07 * (cm.y - c.seed.y) + 0.01 * (home.y - c.seed.y) };
      c.alive += (1 - c.alive) * 0.04;
      c.s += (c.sTarget - c.s) * 0.065;
    }
  }

  // Deja que el nivel se asiente sin pintarlo.
  settle(steps: number, t: number) {
    for (let i = 0; i < steps; i++) this.step(t, null);
  }

  at(p: P) {
    return this.cells.find((c) => c.poly.length > 2 && inside(c.poly, p)) ?? null;
  }

  fraction(c: Cell) {
    return c.area / (Math.abs(polyArea(this.frame)) || 1);
  }
}

/* ── Dibujo ───────────────────────────────────────────────────────────── */

const SVG = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElementNS(SVG, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
};

type CellEls = { g: SVGGElement; path: SVGPathElement; title: SVGTextElement; meta: SVGTextElement; peek: SVGTextElement[]; card?: SVGForeignObjectElement };

const STATUS = { todo: '○', doing: '◐', done: '●' } as const;

class FluidView {
  root: SVGGElement;
  els = new Map<string, CellEls>();
  constructor(parent: SVGElement) {
    this.root = el('g', 'fl-level');
    parent.appendChild(this.root);
  }

  render(fluid: Fluid, t: number, opacity: number, hover: string | null, hideLabelOf: { id: string; amount: number } | null) {
    this.root.style.opacity = String(opacity);
    const { lit, memoria } = fluid.lens;
    const today = Date.now();
    const seen = new Set<string>();
    for (const c of fluid.cells) {
      const id = c.node.id;
      seen.add(id);
      let e = this.els.get(id);
      if (!e) {
        const g = el('g', `fl-cell kind-${c.node.kind}`);
        g.dataset.id = id;
        const path = el('path');
        const title = el('text', 'fl-title');
        const meta = el('text', 'fl-meta');
        g.append(path, title, meta);
        const peek = [0, 1, 2].map(() => {
          const p = el('text', 'fl-peek');
          g.appendChild(p);
          return p;
        });
        this.root.appendChild(g);
        e = { g, path, title, meta, peek };
        this.els.set(id, e);
      }
      const visible = c.drawn.length > 2;
      e.g.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const size = Math.sqrt(Math.abs(polyArea(c.drawn)));
      e.g.style.setProperty('--hue', String(c.hue));
      let fade = 1;
      // Luz como memoria: lo que no tocas en un mes se va apagando.
      const touched = c.node.note?.updatedAt;
      if (memoria && touched && hover !== id) fade *= 1 - 0.45 * Math.min(1, Math.max(0, ((today - Date.parse(touched)) / DAY - 1) / 29));
      if (lit && !lit.has(id)) fade *= 0.22;
      e.g.classList.toggle('lit', !!lit && lit.has(id));
      e.g.style.opacity = String(Math.min(1, c.alive * 1.2) * smooth(18, 50, size) * fade);
      e.g.classList.toggle('hover', hover === id);
      e.g.classList.toggle('done', c.node.note?.kind === 'task' && c.node.note.status === 'done');
      e.path.setAttribute('d', organicPath(c.drawn, t, Math.min(3.5, size / 50)));

      const hidden = hideLabelOf?.id === id ? hideLabelOf.amount : 0;
      const note = c.node.kind === 'note';
      const fs = note ? Math.max(11, Math.min(30, size / 11)) : Math.max(12, Math.min(64, size / 8));
      const bigNote = note && size > 230;
      const labelOpacity = smooth(55, 95, size) * (1 - hidden);
      e.title.style.opacity = String(bigNote ? 0 : labelOpacity);
      e.title.style.fontSize = `${fs}px`;
      e.title.setAttribute('x', c.center.x.toFixed(1));
      e.title.setAttribute('y', (c.center.y - (note ? 0 : fs * 0.3)).toFixed(1));
      const task = c.node.note?.kind === 'task' ? `${STATUS[c.node.note.status ?? 'todo']} ` : '';
      const room = bbox(c.drawn).w * 0.82;
      const maxChars = Math.max(6, Math.floor(room / (fs * (note ? 0.52 : 0.42))));
      const text = task + c.node.title;
      e.title.textContent = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;

      const metaText =
        c.node.kind === 'note'
          ? ''
          : `${c.node.count} ${c.node.count === 1 ? 'nota' : 'notas'}${
              c.node.children.some((k) => k.kind === 'zone') ? ` · ${c.node.children.filter((k) => k.kind === 'zone').length} secc.` : ''
            }`;
      e.meta.textContent = metaText;
      e.meta.setAttribute('x', c.center.x.toFixed(1));
      e.meta.setAttribute('y', (c.center.y + fs * 0.45 + 8).toFixed(1));
      e.meta.style.opacity = String(smooth(110, 160, size) * (1 - hidden));

      const peekOn = !note && size > 300;
      const kids = peekOn ? [...c.node.children].sort((a, b) => b.importance - a.importance).slice(0, 3) : [];
      e.peek.forEach((p, k) => {
        const kid = kids[k];
        p.textContent = kid ? (kid.title.length > 34 ? kid.title.slice(0, 33) + '…' : kid.title) : '';
        p.setAttribute('x', c.center.x.toFixed(1));
        p.setAttribute('y', (c.center.y + fs * 0.45 + 34 + k * 19).toFixed(1));
        p.style.opacity = String(smooth(300, 380, size) * (1 - hidden));
      });

      // Una nota grande enseña su texto.
      if (bigNote) {
        if (!e.card) {
          e.card = el('foreignObject', 'fl-card');
          const div = document.createElement('div');
          div.className = 'fl-card-body';
          e.card.appendChild(div);
          e.g.appendChild(e.card);
        }
        const b = bbox(c.drawn);
        const w = b.w * 0.64;
        const h = b.h * 0.62;
        e.card.setAttribute('x', (c.center.x - w / 2).toFixed(1));
        e.card.setAttribute('y', (c.center.y - h / 2).toFixed(1));
        e.card.setAttribute('width', w.toFixed(1));
        e.card.setAttribute('height', h.toFixed(1));
        e.card.style.opacity = String(smooth(230, 300, size) * (1 - hidden));
        const div = e.card.firstChild as HTMLDivElement;
        div.style.fontSize = `${Math.max(12, Math.min(20, size / 26)).toFixed(1)}px`;
        const key = `${c.node.title}\u0000${c.node.note?.bodyText ?? ''}`;
        if (div.dataset.key !== key) {
          div.dataset.key = key;
          div.replaceChildren();
          const h1 = document.createElement('strong');
          h1.textContent = task + c.node.title;
          const body = c.node.note?.bodyText?.split('\n').slice(1).join('\n').trim() ?? '';
          div.appendChild(h1);
          if (body) {
            const p = document.createElement('p');
            p.textContent = body.slice(0, 600);
            div.appendChild(p);
          }
        }
      } else if (e.card) {
        e.card.remove();
        e.card = undefined;
      }
    }
    for (const [id, e] of this.els)
      if (!seen.has(id)) {
        e.g.remove();
        this.els.delete(id);
      }
  }

  destroy() {
    this.root.remove();
  }
}

/* ── El mapa entero ───────────────────────────────────────────────────── */

type Level = { node: MapNode; fluid: Fluid; view: FluidView };

// Lo que la linterna y la memoria cambian en el dibujo. Un solo objeto que
// comparten todos los niveles.
export type MapLens = {
  // Celdas con algo que la linterna alumbra (una sección, si lo tiene dentro).
  lit: Set<string> | null;
  // Ocultar: lo que no encaja encoge hasta casi desaparecer.
  hide: boolean;
  memoria: boolean;
};
const DAY = 86_400_000;

export type FluidMapEvents = {
  onPath: (path: MapNode[]) => void;
  // `from`: la celda de la nota justo al llenar la pantalla, para que la hoja
  // siga su misma forma y color.
  onOpen: (noteId: string, from: OpenFrom) => void;
};
export type OpenFrom = { rect: { x: number; y: number; w: number; h: number }; hue: number };

const OPEN_AT = 0.95;
// Ritmo de la respiración y las ondas: lento, para que el mapa se sienta en calma.
const TEMPO = 0.4;

export class FluidMap {
  svg: SVGSVGElement;
  levels: Level[] = [];
  nested: Level | null = null;
  frame: P[] = [];
  hover: string | null = null;
  raf = 0;
  paused = false;
  t0 = performance.now();
  events: FluidMapEvents;
  root: MapNode;
  wheelLock = 0;
  // La nota que se abrió al acercarse; al cerrarla vuelve a su sitio.
  opened: string | null = null;
  lens: MapLens = { lit: null, hide: false, memoria: false };
  lensArgs: [Set<string> | null, boolean, boolean] = [null, false, false];

  constructor(host: HTMLElement, root: MapNode, events: FluidMapEvents, startPath: string[] = []) {
    this.events = events;
    this.root = root;
    this.svg = el('svg', 'fl-svg');
    host.appendChild(this.svg);
    this.resize();
    this.levels = [this.makeLevel(root, this.frame, 200)];
    // Entra directamente al nivel en el que estabas.
    for (const id of startPath) {
      const top = this.top();
      const cell = top.fluid.cells.find((c) => c.node.id === id);
      if (!cell || !cell.node.children.length) break;
      cell.s = cell.sTarget = 1.02;
      top.fluid.settle(400, 0);
      top.view.root.style.display = 'none';
      this.levels.push(this.makeLevel(cell.node, this.frame, cell.hue));
    }
    this.levels.forEach((l, i) => (l.view.root.style.display = i === this.levels.length - 1 ? '' : 'none'));
    this.top().fluid.settle(400, 0);
    this.emitPath();
    this.loop();
  }

  private makeLevel(node: MapNode, frame: P[], hue: number): Level {
    const fluid = new Fluid(node, frame, hue);
    fluid.lens = this.lens;
    return { node, fluid, view: new FluidView(this.svg) };
  }

  top() {
    return this.levels[this.levels.length - 1];
  }

  resize() {
    const w = this.svg.parentElement!.clientWidth;
    const h = this.svg.parentElement!.clientHeight;
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.frame = [
      { x: 16, y: 64 },
      { x: w - 16, y: 64 },
      { x: w - 16, y: h - 76 },
      { x: 16, y: h - 76 },
    ];
    for (const l of this.levels) l.fluid.frame = this.frame;
  }

  setTree(root: MapNode) {
    this.root = root;
    let node = root;
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      if (i > 0) {
        const next = node.children.find((c) => c.id === level.node.id);
        if (!next) {
          // Ese nivel ya no existe: se vuelve al anterior.
          for (const l of this.levels.splice(i)) l.view.destroy();
          break;
        }
        node = next;
      }
      level.node = node;
      level.fluid.setNode(node);
    }
    if (this.nested) {
      const next = this.top().node.children.find((c) => c.id === this.nested!.node.id);
      if (next) this.nested.fluid.setNode(next);
      else this.dropNested();
    }
    this.levels.forEach((l, i) => (l.view.root.style.display = i === this.levels.length - 1 ? '' : 'none'));
    this.setLens(...this.lensArgs);
    this.emitPath();
  }

  private emitPath() {
    this.events.onPath(this.levels.map((l) => l.node));
  }

  private dropNested() {
    this.nested?.view.destroy();
    this.nested = null;
  }

  private zoomed() {
    return this.top().fluid.cells.reduce<Cell | null>((m, c) => (c.s > (m?.s ?? 0.02) ? c : m), null);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const t = ((performance.now() - this.t0) / 1000) * TEMPO;
    const top = this.top();
    top.fluid.step(t, this.hover);
    const z = this.zoomed();

    // El nivel de dentro aparece en cuanto la celda crece lo bastante.
    const openable = z && z.node.children.length ? z : null;
    let nestedOpacity = 0;
    if (openable && openable.drawn.length > 2) {
      nestedOpacity = smooth(0.3, 0.7, top.fluid.fraction(openable));
      if (!this.nested || this.nested.node.id !== openable.node.id) {
        this.dropNested();
        this.nested = this.makeLevel(openable.node, openable.drawn, openable.hue);
        this.nested.fluid.settle(240, t);
      }
      this.nested.fluid.frame = openable.drawn;
      this.nested.fluid.step(t, null);
    } else if (this.nested) this.dropNested();

    top.view.render(top.fluid, t, 1, this.hover, openable ? { id: openable.node.id, amount: nestedOpacity } : null);
    if (this.nested) {
      // Encima de su celda, que queda como fondo.
      if (this.svg.lastChild !== this.nested.view.root) this.svg.appendChild(this.nested.view.root);
      this.nested.view.render(this.nested.fluid, t, nestedOpacity, null, null);
    }

    // Entrar: la celda ya llena la pantalla.
    if (z && z.s >= 1 && top.fluid.fraction(z) > OPEN_AT) {
      if (z.node.kind === 'note') {
        if (this.opened !== z.node.id) {
          this.opened = z.node.id;
          this.events.onOpen(z.node.id, { rect: bbox(z.drawn), hue: z.hue });
        }
      } else if (this.nested) {
        const level = this.nested;
        this.nested = null;
        level.fluid.frame = this.frame;
        top.view.root.style.display = 'none';
        this.levels.push(level);
        this.hover = null;
        this.emitPath();
      }
    }
  };

  // Rueda: hacia delante acerca la celda señalada; hacia atrás, aleja.
  wheel(dy: number, p: P) {
    const top = this.top();
    const z = this.zoomed();
    const now = performance.now();
    if (now < this.wheelLock) return;
    const amount = Math.max(-0.12, Math.min(0.12, -dy * 0.0016));
    if (amount > 0) {
      const target = z && z.s > 0.05 ? z : top.fluid.at(p);
      if (!target) return;
      for (const c of top.fluid.cells) if (c !== target) c.sTarget = 0;
      target.sTarget = Math.min(1.06, target.sTarget + amount);
    } else {
      const cur = top.fluid.cells.reduce<Cell | null>((m, c) => (c.sTarget > (m?.sTarget ?? 0.001) ? c : m), null);
      if (cur) cur.sTarget = Math.max(0, cur.sTarget + amount);
      else this.up();
    }
  }

  // Sube un nivel: el de arriba vuelve con esta sección aún ocupándolo todo y,
  // con la rueda, se va encogiendo; con Esc vuelve del todo a su tamaño.
  up(all = false) {
    if (this.levels.length < 2) return;
    const leaving = this.levels.pop()!;
    const top = this.top();
    const cell = top.fluid.cells.find((c) => c.node.id === leaving.node.id);
    this.dropNested();
    top.view.root.style.display = '';
    if (cell) {
      cell.s = 1.02;
      cell.sTarget = all ? 0 : 0.72;
      top.fluid.settle(40, ((performance.now() - this.t0) / 1000) * TEMPO);
      leaving.fluid.frame = cell.drawn.length > 2 ? cell.drawn : this.frame;
      this.nested = leaving;
    } else leaving.view.destroy();
    this.wheelLock = performance.now() + 250;
    this.emitPath();
  }

  // Salta al nivel `depth` (0 = todo).
  upTo(depth: number) {
    while (this.levels.length - 1 > depth) {
      const leaving = this.levels.pop()!;
      leaving.view.destroy();
    }
    this.dropNested();
    const top = this.top();
    top.view.root.style.display = '';
    for (const c of top.fluid.cells) c.s = c.sTarget = 0;
    this.emitPath();
  }

  enter(id: string) {
    const cell = this.top().fluid.cells.find((c) => c.node.id === id);
    if (!cell) return;
    for (const c of this.top().fluid.cells) if (c !== cell) c.sTarget = 0;
    cell.sTarget = 1.06;
  }

  // Linterna: `notes` son las notas que encajan; se alumbran también las
  // secciones que las contienen.
  setLens(notes: Set<string> | null, hide: boolean, memoria: boolean) {
    let lit: Set<string> | null = null;
    if (notes) {
      lit = new Set();
      const walk = (n: MapNode): boolean => {
        let any = n.kind === 'note' && notes.has(n.id);
        for (const c of n.children) if (walk(c)) any = true;
        if (any) lit!.add(n.id);
        return any;
      };
      walk(this.root);
    }
    // Mismo objeto para todos los niveles.
    Object.assign(this.lens, { lit, hide: hide && !!notes, memoria });
    this.lensArgs = [notes, hide, memoria];
  }

  // La hoja de la nota se cerró: la celda se encoge despacio hasta su sitio.
  closed() {
    const cell = this.top().fluid.cells.find((c) => c.node.id === this.opened);
    if (cell) cell.sTarget = 0;
    this.opened = null;
  }

  relax() {
    const top = this.top();
    const any = top.fluid.cells.some((c) => c.sTarget > 0.01);
    if (any) for (const c of top.fluid.cells) c.sTarget = 0;
    else this.up(true);
  }

  pointer(p: P | null) {
    this.hover = p ? (this.top().fluid.at(p)?.node.id ?? null) : null;
    return this.hover;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.svg.remove();
  }
}
