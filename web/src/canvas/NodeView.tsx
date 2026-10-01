import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';
import type { NoteRow } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { parentMap } from './sections';

// Vista de nodos, como el grafo de Obsidian: todas las notas como puntos que
// se ordenan solos (fuerzas), unidos por sus enlaces y por la jerarquía
// madre → hija. El tamaño del punto dice cuántas relaciones tiene. Al pasar
// por encima de una nota se encienden ella y sus vecinas y el resto se apaga;
// los nombres aparecen al acercarse. Se arrastran los puntos, se mueve el
// lienzo y la rueda (o dos dedos) acerca y aleja. Clic abre la nota.

type Props = {
  rows: NoteRow[];
  links: { source: string; target: string }[];
  // Nota en la que se centra la vista; null (o 'loose') es el grafo entero.
  center: string | null;
  paused: boolean;
  onCenter: (id: string | null) => void;
  onOpen: (id: string) => void;
  onAction: (action: MapAction, noteId: string | null, parentId: string | null) => void;
  onMove: (id: string, parentId: string | null) => void;
  lit: Set<string> | null;
  hide: boolean;
};

export const LOOSE = 'loose';

// Lo que se pide desde los nodos o la biblioteca sobre la nota señalada (o,
// para crear, dentro de la nota en la que estás).
export type MapAction = 'create' | 'createCanvas' | 'section' | 'props' | 'delete' | 'rename' | 'archive' | 'move';
const KEYS: Partial<Record<ActionId, MapAction>> = { properties: 'props', deleteCell: 'delete', rename: 'rename', archive: 'archive', move: 'move' };
const NODE_ACTIONS: ActionId[] = ['properties', 'deleteCell', 'rename', 'move', 'archive', 'toRoot', 'newNote', 'newCanvas', 'newSection'];

type GNode = SimulationNodeDatum & { id: string; row: NoteRow; title: string; deg: number; r: number };
type GEdge = { source: GNode; target: GNode; kind: 'tree' | 'link' };

// Ajustes del grafo, como el panel de Obsidian. Se recuerdan en este navegador.
type Opts = { local: boolean; depth: number; tree: boolean; orphans: boolean; arrows: boolean };
const OPTS_KEY = 'canvian.graph';
const DEFAULT_OPTS: Opts = { local: false, depth: 1, tree: true, orphans: true, arrows: false };
function loadOpts(): Opts {
  try {
    return { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_OPTS;
  }
}

// Las posiciones sobreviven a cambiar de vista: el grafo vuelve como estaba.
const remembered = new Map<string, { x: number; y: number }>();
let rememberedView: { x: number; y: number; k: number } | null = null;

const titleOf = (r: NoteRow) => r.title || 'Nota sin título';
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const MIN_K = 0.08;
const MAX_K = 6;

type Palette = { node: string; nodeStrong: string; line: string; lineStrong: string; text: string; textFaint: string; accent: string; bg: string; font: string };

// Los colores salen del tema: se resuelven a rgb con un elemento de prueba
// (algunos son color-mix y el lienzo no siempre los entiende).
function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const get = (v: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${v}, ${fallback})`;
    return getComputedStyle(probe).color || fallback;
  };
  const p: Palette = {
    node: get('--text-faint', '#888'),
    nodeStrong: get('--text', '#eee'),
    line: get('--line-strong', '#444'),
    lineStrong: get('--text-muted', '#aaa'),
    text: get('--text', '#eee'),
    textFaint: get('--text-faint', '#888'),
    accent: get('--accent-ink', '#bbb'),
    bg: get('--bg', '#111'),
    font: getComputedStyle(host).getPropertyValue('--font-ui').trim() || 'Inter, system-ui, sans-serif',
  };
  probe.remove();
  return p;
}

export function NodeView({ rows, links, center, paused, onCenter, onOpen, onAction, lit, hide }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [opts, setOptsState] = useState<Opts>(loadOpts);
  const [panel, setPanel] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const setOpts = (patch: Partial<Opts>) =>
    setOptsState((o) => {
      const next = { ...o, ...patch };
      try {
        localStorage.setItem(OPTS_KEY, JSON.stringify(next));
      } catch {
        /* sin almacenamiento: solo para esta vez */
      }
      return next;
    });

  // Todo lo que el bucle de dibujo lee va por refs: así React no repinta 60 veces por segundo.
  const view = useRef(rememberedView ?? { x: 0, y: 0, k: 1 });
  const viewAnim = useRef<{ from: { x: number; y: number; k: number }; to: { x: number; y: number; k: number }; t0: number; ms: number } | null>(null);
  const hover = useRef<GNode | null>(null);
  const fade = useRef(0);
  const dirty = useRef(true);
  const palette = useRef<Palette | null>(null);
  const sim = useRef<Simulation<GNode, GEdge> | null>(null);
  const graphRef = useRef<{ nodes: GNode[]; edges: GEdge[]; adj: Map<string, Set<string>> }>({ nodes: [], edges: [], adj: new Map() });
  const litRef = useRef({ lit, hide });
  litRef.current = { lit, hide };
  const opened = useRef(false);
  // Si vuelves a los nodos, la cámara sigue donde la dejaste.
  const restored = useRef(!!rememberedView);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const parent = useMemo(() => parentMap(rows), [rows]);
  const focusId = center && center !== LOOSE && byId.has(center) ? center : null;

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Colores del tema, y otra vez cuando cambian el tema o el modo claro/oscuro.
  useEffect(() => {
    const read = () => {
      if (host.current) palette.current = readPalette(host.current);
      dirty.current = true;
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class', 'style'] });
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', read);
    };
  }, []);

  // El grafo: notas, líneas de jerarquía y enlaces; con el filtro local, solo
  // lo que está a `depth` pasos de la nota del centro.
  const graph = useMemo(() => {
    const edgesRaw: { a: string; b: string; kind: 'tree' | 'link' }[] = [];
    const seen = new Set<string>();
    const add = (a: string, b: string, kind: 'tree' | 'link') => {
      if (a === b || !byId.has(a) || !byId.has(b)) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      edgesRaw.push({ a, b, kind });
    };
    for (const l of links) add(l.source, l.target, 'link');
    if (opts.tree) for (const r of rows) {
      const p = parent.get(r.id);
      if (p) add(p, r.id, 'tree');
    }
    const adj = new Map<string, Set<string>>();
    for (const e of edgesRaw) {
      if (!adj.has(e.a)) adj.set(e.a, new Set());
      if (!adj.has(e.b)) adj.set(e.b, new Set());
      adj.get(e.a)!.add(e.b);
      adj.get(e.b)!.add(e.a);
    }
    let keep: Set<string> | null = null;
    if (opts.local && focusId) {
      keep = new Set([focusId]);
      let ring = [focusId];
      for (let d = 0; d < opts.depth; d++) {
        const next: string[] = [];
        for (const id of ring) for (const n of adj.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n));
        ring = next;
      }
    }
    const ids = rows
      .map((r) => r.id)
      .filter((id) => (keep ? keep.has(id) : true))
      .filter((id) => opts.orphans || (adj.get(id)?.size ?? 0) > 0 || id === focusId);
    const idSet = new Set(ids);
    const nodes: GNode[] = ids.map((id) => {
      const row = byId.get(id)!;
      const deg = [...(adj.get(id) ?? [])].filter((n) => idSet.has(n)).length;
      const was = remembered.get(id);
      // Una nota nueva nace junto a una vecina que ya tenga sitio.
      const near = was ?? [...(adj.get(id) ?? [])].map((n) => remembered.get(n)).find(Boolean);
      const jitter = () => (Math.random() - 0.5) * 40;
      return {
        id,
        row,
        title: titleOf(row),
        deg,
        r: 3.2 + Math.sqrt(deg) * 1.9,
        x: was ? was.x : near ? near.x + jitter() : jitter() * 6,
        y: was ? was.y : near ? near.y + jitter() : jitter() * 6,
      };
    });
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const edges: GEdge[] = edgesRaw
      .filter((e) => idSet.has(e.a) && idSet.has(e.b))
      .map((e) => ({ source: nodeById.get(e.a)!, target: nodeById.get(e.b)!, kind: e.kind }));
    const fresh = nodes.filter((n) => !remembered.has(n.id)).length;
    return { nodes, edges, adj, fresh };
  }, [rows, links, parent, byId, opts.tree, opts.local, opts.depth, opts.orphans, focusId]);

  const fit = (animate: boolean, only?: GNode[]) => {
    const { w, h } = size;
    const ns = only ?? graphRef.current.nodes;
    if (!w || !ns.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      x0 = Math.min(x0, n.x!); y0 = Math.min(y0, n.y!);
      x1 = Math.max(x1, n.x!); y1 = Math.max(y1, n.y!);
    }
    const pad = w < 600 ? 32 : 120;
    const k = clamp(Math.min((w - pad) / Math.max(1, x1 - x0), (h - pad - 40) / Math.max(1, y1 - y0)), 0.15, 1.6);
    goTo((x0 + x1) / 2, (y0 + y1) / 2, k, animate);
  };

  // Lleva la cámara a que (wx, wy) quede en el centro de la pantalla, con zoom k.
  const goTo = (wx: number, wy: number, k: number, animate: boolean) => {
    const { w, h } = size;
    const to = { x: w / 2 - wx * k, y: h / 2 - wy * k, k };
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || still) {
      view.current = to;
      viewAnim.current = null;
    } else viewAnim.current = { from: { ...view.current }, to, t0: performance.now(), ms: 750 };
    dirty.current = true;
  };

  // La simulación de fuerzas, rehecha cuando cambia el grafo (las posiciones se conservan).
  useEffect(() => {
    graphRef.current = graph;
    const s = forceSimulation<GNode, GEdge>(graph.nodes)
      .force('charge', forceManyBody<GNode>().strength(-160).distanceMax(700))
      .force('link', forceLink<GNode, GEdge>(graph.edges).distance((e) => (e.kind === 'tree' ? 46 : 70)).strength(0.5))
      .force('x', forceX<GNode>(0).strength(0.045))
      .force('y', forceY<GNode>(0).strength(0.045))
      .force('collide', forceCollide<GNode>((n) => n.r + 4))
      .alphaDecay(0.025)
      .velocityDecay(0.45)
      .stop();
    // Las que ya tenían sitio apenas se mueven; si todo es nuevo, se coloca
    // antes de enseñarlo para que no aparezca un estallido.
    if (graph.fresh > graph.nodes.length / 2) {
      s.alpha(1);
      while (s.alpha() > 0.02) s.tick();
      for (const n of graph.nodes) remembered.set(n.id, { x: n.x!, y: n.y! });
      s.alpha(0.05);
    } else s.alpha(graph.fresh ? 0.4 : 0.1);
    s.on('tick', () => {
      dirty.current = true;
      for (const n of graph.nodes) remembered.set(n.id, { x: n.x!, y: n.y! });
    });
    s.restart();
    sim.current = s;
    dirty.current = true;
    return () => {
      s.stop();
    };
  }, [graph]);

  // Al entrar (o al cambiar de nota en el centro), la cámara va hacia ella.
  useEffect(() => {
    if (!size.w) return;
    const n = focusId ? graph.nodes.find((x) => x.id === focusId) : null;
    if (n) goTo(n.x!, n.y!, opened.current ? Math.max(view.current.k, 0.9) : 1.4, opened.current);
    else if (!opened.current && !restored.current) fit(false);
    opened.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, size.w > 0, opts.local]);

  // Con el filtro local, el trozo de grafo se encuadra cuando se ha colocado.
  useEffect(() => {
    if (!opts.local || !focusId || !size.w) return;
    const t = setTimeout(() => fit(true), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    dirty.current = true;
  }, [lit, hide, size]);

  useEffect(() => () => void (rememberedView = { ...view.current }), []);

  // Bucle de dibujo: solo pinta cuando algo cambió.
  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const a = viewAnim.current;
      if (a) {
        const t = clamp((now - a.t0) / a.ms, 0, 1);
        const e = 1 - Math.pow(1 - t, 3);
        view.current = { x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e, k: a.from.k + (a.to.k - a.from.k) * e };
        if (t >= 1) viewAnim.current = null;
        dirty.current = true;
      }
      const want = hover.current ? 1 : 0;
      if (fade.current !== want) {
        fade.current = want > fade.current ? Math.min(1, fade.current + 0.09) : Math.max(0, fade.current - 0.06);
        dirty.current = true;
      }
      if (dirty.current) {
        dirty.current = false;
        drawRef.current();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // Último nodo señalado, para seguir apagando el resto mientras se desvanece.
  const lastHover = useRef<GNode | null>(null);

  const drawRef = useRef(() => {});
  drawRef.current = () => draw();
  useEffect(() => {
    dirty.current = true;
  });

  const draw = () => {
    const c = canvas.current;
    const pal = palette.current;
    if (!c || !pal) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const { x: tx, y: ty, k } = view.current;
    const { nodes, edges, adj } = graphRef.current;
    const { lit: litSet, hide: hideDim } = litRef.current;
    if (hover.current) lastHover.current = hover.current;
    const h = lastHover.current;
    const f = fade.current;
    const near = h ? adj.get(h.id) ?? new Set<string>() : null;
    const isNear = (id: string) => !!h && (id === h.id || near!.has(id));
    // Las vecinas de la nota del centro también llevan su nombre.
    const focusNear = focusId ? adj.get(focusId) : null;
    const litAlpha = (n: GNode) => (litSet && !litSet.has(n.id) ? (hideDim ? 0 : 0.15) : 1) * (n.row.archivedAt ? 0.45 : 1);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);

    // Líneas.
    ctx.lineCap = 'round';
    for (const e of edges) {
      const on = h && (e.source.id === h.id || e.target.id === h.id);
      const base = Math.min(litAlpha(e.source), litAlpha(e.target));
      if (!base) continue;
      const alpha = base * (on ? 1 : 1 - f * 0.85) * (e.kind === 'tree' ? 0.75 : 1);
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = on && f > 0 ? pal.accent : e.kind === 'link' ? pal.lineStrong : pal.line;
      ctx.lineWidth = (on ? 1.6 : e.kind === 'link' ? 1.1 : 0.9) / Math.sqrt(k);
      ctx.beginPath();
      ctx.moveTo(e.source.x!, e.source.y!);
      ctx.lineTo(e.target.x!, e.target.y!);
      ctx.stroke();
      if (opts.arrows && e.kind === 'link') {
        const dx = e.target.x! - e.source.x!, dy = e.target.y! - e.source.y!;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const px = e.target.x! - ux * (e.target.r + 2), py = e.target.y! - uy * (e.target.r + 2);
        const s = 5 / Math.sqrt(k);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - ux * s - uy * s * 0.6, py - uy * s + ux * s * 0.6);
        ctx.lineTo(px - ux * s + uy * s * 0.6, py - uy * s - ux * s * 0.6);
        ctx.fill();
      }
    }

    // Puntos.
    for (const n of nodes) {
      const base = litAlpha(n);
      if (!base) continue;
      const on = isNear(n.id);
      ctx.globalAlpha = base * (on || !h ? 1 : 1 - f * 0.8);
      const isFocus = n.id === focusId;
      ctx.fillStyle = h && n.id === h.id && f > 0 ? pal.accent : isFocus ? pal.nodeStrong : on && f > 0 ? pal.lineStrong : pal.node;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (isFocus) {
        ctx.strokeStyle = pal.nodeStrong;
        ctx.lineWidth = 1.2 / k;
        ctx.globalAlpha *= 0.5;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 4 / Math.sqrt(k), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Nombres, en pantalla (siempre nítidos): aparecen al acercarse; la nota
    // señalada, sus vecinas y la del centro se leen siempre.
    const zoomAlpha = clamp((k - 1.05) / 0.5, 0, 1);
    const fontPx = clamp(11 + (k - 1) * 2.5, 10, 15);
    ctx.font = `${fontPx}px ${pal.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of nodes) {
      const base = litAlpha(n);
      if (!base) continue;
      const on = isNear(n.id);
      const always = n.id === focusId || (on && f > 0);
      let a = always ? Math.max(zoomAlpha, on ? f : 1) : Math.max(zoomAlpha, focusNear?.has(n.id) ? 0.8 : 0) * (h ? 1 - f * 0.85 : 1);
      a *= base;
      if (a <= 0.02) continue;
      const sx = n.x! * k + tx;
      const sy = n.y! * k + ty;
      if (sx < -200 || sx > size.w + 200 || sy < -40 || sy > size.h + 40) continue;
      const label = n.title.length > 32 ? n.title.slice(0, 31) + '…' : n.title;
      ctx.globalAlpha = a;
      ctx.fillStyle = (h && n.id === h.id) || n.id === focusId ? pal.text : pal.textFaint;
      ctx.fillText(label, sx, sy + n.r * k + 5);
    }
    ctx.globalAlpha = 1;
  };

  // Tamaño del lienzo según la pantalla (y nítido en pantallas densas).
  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    dirty.current = true;
  }, [size]);

  // ── Ratón, dedos y rueda ────────────────────────────────────────────
  const toWorld = (sx: number, sy: number) => ({ x: (sx - view.current.x) / view.current.k, y: (sy - view.current.y) / view.current.k });
  const hit = (sx: number, sy: number): GNode | null => {
    const { x, y } = toWorld(sx, sy);
    const { lit: litSet, hide: hideDim } = litRef.current;
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of graphRef.current.nodes) {
      if (hideDim && litSet && !litSet.has(n.id)) continue;
      const d = Math.hypot(n.x! - x, n.y! - y);
      const reach = Math.max(n.r + 3, 12 / view.current.k);
      if (d < reach && d < bestD) (best = n), (bestD = d);
    }
    return best;
  };
  const setHover = (n: GNode | null) => {
    if (hover.current === n) return;
    hover.current = n;
    setHoverId(n?.id ?? null);
    dirty.current = true;
  };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ node: GNode | null; sx: number; sy: number; moved: boolean; pinch: { d: number; k: number; cx: number; cy: number } | null } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    setPanel(false);
    const p = local(e);
    canvas.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);
    viewAnim.current = null;
    if (pointers.current.size === 2) {
      // Dos dedos: acercar o alejar.
      const [a, b] = [...pointers.current.values()];
      if (gesture.current?.node) {
        gesture.current.node.fx = gesture.current.node.fy = null;
      }
      gesture.current = { node: null, sx: 0, sy: 0, moved: true, pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.current.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 } };
      return;
    }
    const n = hit(p.x, p.y);
    gesture.current = { node: n, sx: p.x, sy: p.y, moved: false, pinch: null };
    if (n) {
      setHover(n);
      n.fx = n.x;
      n.fy = n.y;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const prev = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (!prev || !g) {
      if (e.pointerType === 'mouse') setHover(hit(p.x, p.y));
      return;
    }
    pointers.current.set(e.pointerId, p);
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const k = clamp((g.pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, g.pinch.d), MIN_K, MAX_K);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const w = toWorld(g.pinch.cx, g.pinch.cy);
      view.current = { x: cx - w.x * k, y: cy - w.y * k, k };
      g.pinch.k = k;
      g.pinch.d = Math.hypot(a.x - b.x, a.y - b.y);
      g.pinch.cx = cx;
      g.pinch.cy = cy;
      dirty.current = true;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 5) return;
    g.moved = true;
    if (g.node) {
      const w = toWorld(p.x, p.y);
      g.node.fx = w.x;
      g.node.fy = w.y;
      sim.current?.alphaTarget(0.25).restart();
    } else {
      view.current = { ...view.current, x: view.current.x + p.x - prev.x, y: view.current.y + p.y - prev.y };
      dirty.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (!g) return;
    if (g.node) {
      g.node.fx = g.node.fy = null;
      sim.current?.alphaTarget(0);
      if (!g.moved && e.type === 'pointerup') onOpen(g.node.id);
    }
    if (e.pointerType !== 'mouse') setHover(null);
  };

  useEffect(() => {
    const c = canvas.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewAnim.current = null;
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const w = toWorld(sx, sy);
      const k = clamp(view.current.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), MIN_K, MAX_K);
      view.current = { x: sx - w.x * k, y: sy - w.y * k, k };
      dirty.current = true;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  // Teclado: los atajos de siempre sobre la nota señalada (o la del centro).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
      if (t && t !== document.body && !host.current?.contains(t)) return;
      if (e.key === 'Escape' && (lit || document.querySelector('.inspector, .lantern'))) return;
      const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
      const target = hover.current?.id ?? focusId;
      const action = actionFor(e, NODE_ACTIONS);
      if (action && KEYS[action]) {
        if (target) onAction(KEYS[action]!, target, null);
      } else if (action === 'toRoot') {
        onCenter(null);
        fit(true);
      } else if (action === 'newNote') onAction('create', null, focusId);
      else if (action === 'newCanvas') onAction('createCanvas', null, focusId);
      else if (action === 'newSection') onAction('section', null, target);
      else if (plain && e.key === 'Enter' && target) onOpen(target);
      else if (plain && (e.key === 'Escape' || e.key === 'Backspace')) {
        if (panel) setPanel(false);
        else if (focusId) onCenter(null);
        else return;
      } else if (plain && (e.key === '0' || e.key === '.')) fit(true);
      else if (plain && (e.key === '+' || e.key === '=' || e.key === '-')) zoomBy(e.key === '-' ? 1 / 1.4 : 1.4);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const zoomBy = (factor: number) => {
    const { w, h } = size;
    const c = toWorld(w / 2, h / 2);
    goTo(c.x, c.y, clamp(view.current.k * factor, MIN_K, MAX_K), true);
  };

  const hovered = hoverId ? byId.get(hoverId) : null;

  return (
    <div ref={host} className={`nodes graph${hoverId ? ' is-pointing' : ''}`}>
      <canvas
        ref={canvas}
        className="graph-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(e) => e.pointerType === 'mouse' && !gesture.current && setHover(null)}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Grafo de notas"
      />
      <div className="graph-tools">
        <button className="graph-tool" onClick={() => zoomBy(1.4)} aria-label="Acercar" title="Acercar (+)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" /></svg>
        </button>
        <button className="graph-tool" onClick={() => zoomBy(1 / 1.4)} aria-label="Alejar" title="Alejar (−)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h10" /></svg>
        </button>
        <button className="graph-tool" onClick={() => fit(true)} aria-label="Encuadrar todo" title="Encuadrar todo (0)">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" /></svg>
        </button>
        <button className={`graph-tool${panel ? ' on' : ''}`} onClick={() => setPanel((v) => !v)} aria-label="Ajustes del grafo" title="Ajustes del grafo">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 4h6M11 4h1M2 10h1M6 10h6" /><circle cx="9.5" cy="4" r="1.5" /><circle cx="4.5" cy="10" r="1.5" /></svg>
        </button>
      </div>
      {panel && (
        <div className="graph-panel" onPointerDown={(e) => e.stopPropagation()}>
          <label className="graph-opt">
            <input type="checkbox" checked={opts.local} disabled={!focusId} onChange={(e) => setOpts({ local: e.target.checked })} />
            <span>Solo alrededor de la nota</span>
          </label>
          {opts.local && focusId && (
            <label className="graph-opt graph-depth">
              <span>Profundidad</span>
              <input type="range" min={1} max={4} value={opts.depth} onChange={(e) => setOpts({ depth: +e.target.value })} />
              <span className="graph-depth-n">{opts.depth}</span>
            </label>
          )}
          <label className="graph-opt">
            <input type="checkbox" checked={opts.tree} onChange={(e) => setOpts({ tree: e.target.checked })} />
            <span>Líneas madre → hija</span>
          </label>
          <label className="graph-opt">
            <input type="checkbox" checked={opts.orphans} onChange={(e) => setOpts({ orphans: e.target.checked })} />
            <span>Notas sin relaciones</span>
          </label>
          <label className="graph-opt">
            <input type="checkbox" checked={opts.arrows} onChange={(e) => setOpts({ arrows: e.target.checked })} />
            <span>Flechas en los enlaces</span>
          </label>
          <p className="graph-count">
            {graph.nodes.length} notas · {graph.edges.length} relaciones
          </p>
        </div>
      )}
      {hovered && (
        <div className="graph-hint" aria-live="polite">
          {titleOf(hovered)}
          <span className="graph-hint-meta"> · {(graph.adj.get(hovered.id)?.size ?? 0) || 'sin'} relaci{(graph.adj.get(hovered.id)?.size ?? 0) === 1 ? 'ón' : 'ones'}</span>
        </div>
      )}
      {!rows.length && <p className="meta nodes-empty">N para la primera nota</p>}
    </div>
  );
}
