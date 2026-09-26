import { useContext, useEffect, useRef } from 'react';
import { useStoreApi, type InternalNode, type ReactFlowState } from '@xyflow/react';
import { useCanvasActions, type NoteData } from './context';
import { DegreeContext } from './degrees';
import { useExperiments } from '../lab/experiments';
import { CONSTELLATION_ZOOM, DEEP_ZOOM } from './Constellation';

// Modo constelación: las estrellas y sus nombres se dibujan en un solo <canvas>
// encima del lienzo. Con elementos de la página (una estrella por nota) cada
// paso del zoom recalculaba miles de estilos; aquí es un dibujo por fotograma.
// Las notas siguen debajo, transparentes, para poder señalarlas y moverlas.

const DAY = 86_400_000;
const GROW_MS = 700;
const TWINKLE_MS = 3600;
const LABEL_MAX = 220;

type Palette = { star: string; todo: string; done: string; glow: string; ring: string; label: string; hover: string; font: string };

// Resuelve colores con color-mix() a algo que el <canvas> entienda.
function readPalette(el: HTMLElement): Palette {
  const probe = document.createElement('span');
  el.appendChild(probe);
  const resolve = (value: string) => {
    probe.style.color = value;
    return getComputedStyle(probe).color;
  };
  const p = {
    star: resolve('color-mix(in oklab, var(--accent) 45%, white)'),
    todo: resolve('color-mix(in oklab, var(--hue-amber) 55%, white)'),
    done: resolve('var(--text-faint)'),
    glow: resolve('var(--accent-glow)'),
    ring: resolve('var(--accent-line)'),
    label: resolve('var(--text-muted)'),
    hover: resolve('var(--text)'),
    font: getComputedStyle(el).getPropertyValue('--font-serif') || 'Georgia, serif',
  };
  probe.remove();
  return p;
}

// Un halo difuminado, pintado una vez y reutilizado para todas las estrellas.
function glowSprite(color: string) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'transparent');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export function StarLayer() {
  const store = useStoreApi();
  const degrees = useContext(DegreeContext)!;
  const { lit } = useCanvasActions();
  const exp = useExperiments();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Lo que cambia sin pasar por React Flow va en una ref para que el dibujo lo lea.
  const extra = useRef({ lit, memoria: exp.memoria, enabled: exp.constelacion });
  extra.current = { lit, memoria: exp.memoria, enabled: exp.constelacion };
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const host = canvas.parentElement!;
    let palette: Palette | null = null;
    let sprite: HTMLCanvasElement | null = null;
    let enteredAt = 0;
    let active = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hovered: string | null = null;
    const labels = new Map<string, { text: string; font: string; out: string }>();
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      width = host.clientWidth;
      height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      schedule();
    };

    const fit = (id: string, text: string, font: string) => {
      const hit = labels.get(id);
      if (hit && hit.text === text && hit.font === font) return hit.out;
      let out = text;
      if (ctx.measureText(out).width > LABEL_MAX) {
        while (out.length > 1 && ctx.measureText(out + '…').width > LABEL_MAX) out = out.slice(0, -1);
        out += '…';
      }
      labels.set(id, { text, font, out });
      return out;
    };

    const draw = (now: number) => {
      frame = 0;
      const state: ReactFlowState = store.getState();
      const [tx, ty, zoom] = state.transform;
      const { lit, memoria, enabled } = extra.current;
      const on = enabled && zoom < CONSTELLATION_ZOOM;
      if (on !== active) {
        active = on;
        enteredAt = now;
        canvas.classList.toggle('on', on);
        if (on) {
          palette = readPalette(host);
          sprite = glowSprite(palette.glow);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!active || !palette || !sprite) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const grow = ease((now - enteredAt) / GROW_MS);
      const deep = zoom < DEEP_ZOOM;
      const font = `italic 13px ${palette.font}`;
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      let twinkling = false;
      const today = Date.now();

      const stars: { n: InternalNode; x: number; y: number; bloom: number; alpha: number; hub: boolean }[] = [];
      for (const n of state.nodeLookup.values()) {
        if (n.type !== 'note' || n.hidden || n.className?.includes('lens-out')) continue;
        const w = n.measured.width ?? 0;
        const h = n.measured.height ?? 0;
        const x = (n.internals.positionAbsolute.x + w / 2) * zoom + tx;
        const y = (n.internals.positionAbsolute.y + h / 2) * zoom + ty;
        if (x < -LABEL_MAX || x > width + LABEL_MAX || y < -40 || y > height + 40) continue;
        const degree = degrees.get(n.id);
        const bloom = Math.min(degree, 6) / 6;
        const data = n.data as NoteData;
        let alpha = 1;
        if (memoria && data.updatedAt && !n.selected && n.id !== hovered) {
          const days = (today - Date.parse(data.updatedAt)) / DAY;
          alpha *= 1 - 0.45 * Math.min(1, Math.max(0, (days - 1) / 29));
        }
        if (lit && !lit.has(n.id)) alpha *= 0.15;
        stars.push({ n, x, y, bloom, alpha, hub: degree >= 3 });
      }

      // Primero los halos, luego los núcleos y al final los nombres, para que
      // ningún brillo tape un nombre.
      for (const s of stars) {
        const data = s.n.data as NoteData;
        if (data.kind === 'task' && data.status === 'done') continue;
        let r = (3 + 4 * s.bloom) * grow;
        if (s.hub) {
          twinkling = true;
          r *= 1 - 0.18 * (0.5 - 0.5 * Math.cos(((now + s.n.id.charCodeAt(s.n.id.length - 1) * 97) / TWINKLE_MS) * 2 * Math.PI));
        }
        const halo = r * (s.n.selected ? 7 : 4.5);
        ctx.globalAlpha = s.alpha;
        ctx.drawImage(sprite, s.x - halo, s.y - halo, halo * 2, halo * 2);
      }
      for (const s of stars) {
        const data = s.n.data as NoteData;
        const done = data.kind === 'task' && data.status === 'done';
        const r = (3 + 4 * s.bloom) * grow;
        ctx.globalAlpha = s.alpha;
        ctx.fillStyle = done ? palette.done : data.kind === 'task' && (data.status ?? 'todo') === 'todo' ? palette.todo : palette.star;
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(r, 0.5), 0, Math.PI * 2);
        ctx.fill();
        if (s.n.selected) {
          ctx.strokeStyle = palette.ring;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      for (const s of stars) {
        const focus = s.n.selected || s.n.id === hovered;
        if (deep && !s.hub && !focus) continue;
        const base = deep ? s.bloom * s.bloom : 0.55 + 0.45 * s.bloom;
        const alpha = (focus ? 1 : base) * s.alpha * grow;
        if (alpha < 0.03) continue;
        const data = s.n.data as NoteData;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = focus ? palette.hover : palette.label;
        ctx.fillText(fit(s.n.id, data.title || 'Nota', font), s.x, s.y + 10 + 10 * s.bloom);
      }
      ctx.globalAlpha = 1;

      // Sigue animando mientras crecen; el titileo es lento y le bastan 20 fps.
      if (grow < 1) frame = requestAnimationFrame(draw);
      else if (twinkling) {
        clearTimeout(timer);
        timer = setTimeout(schedule, 50);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current = schedule;

    const onOver = (e: MouseEvent) => {
      const id = (e.target as HTMLElement).closest?.('.react-flow__node')?.getAttribute('data-id') ?? null;
      if (id !== hovered) {
        hovered = id;
        if (active) schedule();
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    host.addEventListener('mouseover', onOver);
    const unsubscribe = store.subscribe(schedule);
    const unsubscribeDegrees = degrees.subscribe(schedule);
    resize();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      ro.disconnect();
      host.removeEventListener('mouseover', onOver);
      unsubscribe();
      unsubscribeDegrees();
    };
  }, [store, degrees]);

  // La linterna o el laboratorio también cambian el dibujo.
  useEffect(() => redraw.current(), [lit, exp.memoria, exp.constelacion]);

  return <canvas ref={canvasRef} className="star-layer" aria-hidden="true" />;
}
