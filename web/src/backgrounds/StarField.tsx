import { useEffect, useRef } from 'react';

type Star = { x: number; y: number; r: number; depth: number; phase: number; speed: number };

const TILE = 1600; // el cielo se repite en mosaico para poder desplazarse sin bordes

function makeStars(count: number): Star[] {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: count }, () => {
    const depth = rnd(); // 0 = lejos, 1 = cerca
    return {
      x: rnd() * TILE,
      y: rnd() * TILE,
      r: 0.35 + depth * 1.1,
      depth,
      phase: rnd() * Math.PI * 2,
      speed: 0.4 + rnd() * 1.6,
    };
  });
}

const STARS = makeStars(420);

// Cielo en <canvas>: las estrellas titilan y derivan muy despacio, las
// cercanas un poco más rápido que las lejanas (paralaje).
export function StarField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let raf = 0;
    const tint = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fd1c5';

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const vx = -t * 0.004;
      const vy = -t * 0.0015;
      ctx.clearRect(0, 0, w, h);
      for (const s of STARS) {
        const k = 0.02 + s.depth * 0.08;
        const x = (((s.x + vx * k) % TILE) + TILE) % TILE;
        const y = (((s.y + vy * k) % TILE) + TILE) % TILE;
        if (x > w || y > h) continue;
        const twinkle = reduced ? 0.8 : 0.55 + 0.45 * Math.sin(t / 1000 * s.speed + s.phase);
        ctx.globalAlpha = (0.25 + s.depth * 0.6) * twinkle;
        ctx.fillStyle = s.depth > 0.93 ? tint : '#e8ecf5';
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = (t: number) => {
      frame++;
      // A 30 fps basta para un titileo suave y gasta la mitad.
      if (frame % 2 === 0 && !document.hidden) draw(t);
      raf = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener('resize', resize);
    if (reduced) draw(0);
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="ambient stars" aria-hidden="true" />;
}
