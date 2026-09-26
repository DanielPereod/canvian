import { useEffect, useRef, useState } from 'react';
import { FluidMap } from './fluid';
import type { MapNode } from './sections';

// Experimento «Secciones»: el lienzo entero como un mapa vivo. Cada sección
// ocupa pantalla según la importancia de lo que tiene, y dentro de cada una
// están sus subsecciones y, al fondo, sus notas. La rueda acerca y aleja sin
// saltos; los bordes fluyen y las vecinas se apartan.

type Props = {
  tree: MapNode;
  paused: boolean;
  // Dónde estaba el mapa la última vez (ids desde la raíz).
  start: string[];
  onPath: (ids: string[]) => void;
  onOpen: (noteId: string) => void;
  onCreate: (zoneId: string | null, near: MapNode) => void;
};

export function SectionMap({ tree, paused, start, onPath, onOpen, onCreate }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<FluidMap | null>(null);
  const [path, setPath] = useState<MapNode[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const events = useRef({ onOpen, onPath });
  events.current = { onOpen, onPath };

  useEffect(() => {
    const m = new FluidMap(
      host.current!,
      tree,
      {
        onPath: (p) => {
          setPath(p);
          events.current.onPath(p.slice(1).map((n) => n.id));
        },
        onOpen: (id) => events.current.onOpen(id),
      },
      start,
    );
    map.current = m;
    const onResize = () => m.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      m.destroy();
      map.current = null;
    };
    // El mapa se crea una vez; el árbol nuevo le llega por setTree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => map.current?.setTree(tree), [tree]);
  useEffect(() => {
    if (map.current) map.current.paused = paused;
  }, [paused]);

  // La rueda del navegador no puede ser pasiva: la usamos para acercar.
  useEffect(() => {
    const el = host.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      map.current?.wheel(e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const here = path.at(-1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || !map.current) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
      const hovered = here?.children.find((c) => c.id === hover);
      if (e.key === 'Escape' || e.key === 'Backspace') map.current.relax();
      else if (e.key === 'Enter' && hovered) {
        if (hovered.kind === 'note') onOpen(hovered.id);
        else map.current.enter(hovered.id);
      } else if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && here) {
        // Nota nueva en la sección señalada o, si no, en la que estás.
        const into = hovered && hovered.kind !== 'note' ? hovered : here;
        onCreate(into.zoneId, into);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const local = (e: React.MouseEvent) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="smap">
      <div
        ref={host}
        className={`smap-stage${hover ? ' pointing' : ''}`}
        onMouseMove={(e) => setHover(map.current?.pointer(local(e)) ?? null)}
        onMouseLeave={() => {
          map.current?.pointer(null);
          setHover(null);
        }}
        onClick={(e) => {
          const id = map.current?.pointer(local(e));
          if (id && here?.children.some((c) => c.id === id)) map.current?.enter(id);
        }}
        onDoubleClick={(e) => {
          const id = map.current?.pointer(local(e));
          const node = here?.children.find((c) => c.id === id);
          if (node?.kind === 'note') onOpen(node.id);
        }}
      />
      <nav className="smap-crumbs">
        {path.map((n, i) => (
          <span key={n.id} className="smap-crumb-wrap">
            {i > 0 && (
              <span className="smap-sep" aria-hidden="true">
                ›
              </span>
            )}
            <button className={i === path.length - 1 ? 'smap-crumb current' : 'smap-crumb'} onClick={() => i < path.length - 1 && map.current?.upTo(i)}>
              {n.title}
            </button>
          </span>
        ))}
      </nav>
      <p className="smap-hint meta">Rueda para acercar y alejar · clic para entrar · N nota nueva · Esc atrás</p>
    </div>
  );
}
