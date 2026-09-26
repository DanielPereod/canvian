import { useEffect, useRef, useState } from 'react';
import { FluidMap, type OpenFrom } from './fluid';
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
  onOpen: (noteId: string, from: OpenFrom) => void;
  onCreate: (zoneId: string | null, near: MapNode) => void;
  // Atajos sobre la nota señalada: T tarea, X estado, P propiedades, Supr borrar.
  onNoteKey: (key: NoteKey, noteId: string) => void;
  lit: Set<string> | null;
  hide: boolean;
  memoria: boolean;
};

export type NoteKey = 'task' | 'status' | 'props' | 'delete';
const NOTE_KEYS: Record<string, NoteKey> = { t: 'task', x: 'status', p: 'props', delete: 'delete' };

export function SectionMap({ tree, paused, start, onPath, onOpen, onCreate, onNoteKey, lit, hide, memoria }: Props) {
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
        onOpen: (id, from) => events.current.onOpen(id, from),
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
  useEffect(() => map.current?.setLens(lit, hide, memoria), [lit, hide, memoria]);
  useEffect(() => {
    if (!map.current) return;
    map.current.paused = paused;
    if (!paused) map.current.closed();
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
      // Teclas dentro de un panel (inspector, linterna…) son de ese panel.
      if (target && target !== document.body && !host.current?.contains(target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Con la linterna o el inspector abiertos, Esc los cierra primero.
      if (e.key === 'Escape' && (lit || document.querySelector('.inspector'))) return;
      const hovered = here?.children.find((c) => c.id === hover);
      const key = e.key.toLowerCase();
      if (NOTE_KEYS[key]) {
        if (hovered?.kind === 'note') onNoteKey(NOTE_KEYS[key], hovered.id);
      } else if (key === '1') map.current.upTo(0);
      // Sin lienzo libre no hay selección que encuadrar ni zona que dibujar.
      else if (key === '2' || key === 'g') {
        /* nada */
      } else if (e.key === 'Escape' || e.key === 'Backspace') map.current.relax();
      // Una nota también se abre acercándose hasta llenar la pantalla.
      else if (e.key === 'Enter' && hovered) map.current.enter(hovered.id);
      else if (key === 'n' && here) {
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
    </div>
  );
}
