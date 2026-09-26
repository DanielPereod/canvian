import { useEffect, useRef, useState } from 'react';
import { FluidMap, type OpenFrom } from './fluid';
import type { MapNode } from './sections';
import { actionFor, keysBlocked, type ActionId } from '../keys';

// El mapa de secciones: todo Canvian como un mapa vivo. Cada sección ocupa
// pantalla según la importancia de lo que tiene, y dentro de cada una están
// sus subsecciones y, al fondo, sus notas. La rueda acerca y aleja sin saltos;
// los bordes fluyen y las vecinas se apartan. Arrastrar una celda sobre una
// sección (o sobre una miga de pan) la mueve allí.

// Lo que se pide desde el mapa sobre la celda señalada (o la sección en la
// que estás, para crear).
export type MapAction = 'create' | 'section' | 'task' | 'status' | 'block' | 'props' | 'delete' | 'rename';

type Props = {
  tree: MapNode;
  paused: boolean;
  // Dónde estaba el mapa la última vez (ids desde la raíz).
  start: string[];
  onPath: (ids: string[]) => void;
  onOpen: (noteId: string, from: OpenFrom) => void;
  onAction: (action: MapAction, node: MapNode) => void;
  // Mover una nota o sección a otra sección (null: a la raíz).
  onMove: (id: string, zoneId: string | null) => void;
  lit: Set<string> | null;
  hide: boolean;
  memoria: boolean;
};

const KEYS: Partial<Record<ActionId, MapAction>> = { toggleTask: 'task', cycleStatus: 'status', blockTask: 'block', properties: 'props', deleteCell: 'delete', rename: 'rename' };
const MAP_ACTIONS: ActionId[] = ['toggleTask', 'cycleStatus', 'blockTask', 'properties', 'deleteCell', 'rename', 'toRoot', 'newNote', 'newSection'];
const DRAG_FROM = 6;

// Sección a la que va lo que se suelta sobre este nodo; undefined si no admite.
const dropZone = (n: MapNode): string | null | undefined =>
  n.kind === 'zone' ? n.id : n.kind === 'root' || n.id === 'loose' ? null : undefined;

export function SectionMap({ tree, paused, start, onPath, onOpen, onAction, onMove, lit, hide, memoria }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<FluidMap | null>(null);
  const [path, setPath] = useState<MapNode[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  // Arrastre: qué celda, dónde va el fantasma y sobre qué sección se soltaría.
  const [drag, setDrag] = useState<{ node: MapNode; x: number; y: number; target: { id: string; zoneId: string | null } | null } | null>(null);
  const press = useRef<{ x: number; y: number; id: string } | null>(null);
  const dragged = useRef(false);
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
  useEffect(() => map.current?.setDrag(drag?.node.id ?? null, drag?.target?.id ?? null), [drag]);

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
      if (paused || !map.current || !here || keysBlocked()) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
      // Teclas dentro de un panel (inspector, linterna…) son de ese panel.
      if (target && target !== document.body && !host.current?.contains(target)) return;
      // Con la linterna o el inspector abiertos, Esc los cierra primero.
      if (e.key === 'Escape' && (lit || document.querySelector('.inspector, .lantern'))) return;
      const hovered = here.children.find((c) => c.id === hover);
      const action = actionFor(e, MAP_ACTIONS);
      const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
      if (action && KEYS[action]) {
        if (hovered) onAction(KEYS[action]!, hovered);
      } else if (action === 'toRoot') map.current.upTo(0);
      // Nota nueva en la sección señalada o, si no, en la que estás.
      else if (action === 'newNote') onAction('create', hovered && hovered.kind !== 'note' ? hovered : here);
      // Sección nueva en la que estás.
      else if (action === 'newSection') onAction('section', here);
      else if (plain && (e.key === 'Escape' || e.key === 'Backspace')) map.current.relax();
      // Una nota también se abre acercándose hasta llenar la pantalla.
      else if (plain && e.key === 'Enter' && hovered) map.current.enter(hovered.id);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Arrastre con el ratón: sigue fuera del mapa para poder soltar en las migas.
  useEffect(() => {
    const targetAt = (x: number, y: number, id: string) => {
      const crumb = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-crumb]');
      if (crumb) {
        const node = path[Number(crumb.dataset.crumb)];
        const zoneId = node && dropZone(node);
        return node && zoneId !== undefined ? { id: 'crumb:' + node.id, zoneId } : null;
      }
      const r = host.current!.getBoundingClientRect();
      const over = map.current?.pointer({ x: x - r.left, y: y - r.top });
      const node = here?.children.find((c) => c.id === over);
      const zoneId = node && node.id !== id ? dropZone(node) : undefined;
      return node && zoneId !== undefined ? { id: node.id, zoneId } : null;
    };
    const onMouseMove = (e: MouseEvent) => {
      const p = press.current;
      if (!p) return;
      if (!drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_FROM) return;
      const node = here?.children.find((c) => c.id === p.id);
      if (!node) return;
      dragged.current = true;
      setDrag({ node, x: e.clientX, y: e.clientY, target: targetAt(e.clientX, e.clientY, p.id) });
    };
    const onMouseUp = () => {
      const p = press.current;
      press.current = null;
      if (drag?.target && p) onMove(p.id, drag.target.zoneId);
      setDrag(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  });

  const local = (e: React.MouseEvent) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className={`smap${drag ? ' dragging' : ''}`}>
      <div
        ref={host}
        className={`smap-stage${hover ? ' pointing' : ''}`}
        onMouseMove={(e) => !drag && setHover(map.current?.pointer(local(e)) ?? null)}
        onMouseLeave={() => {
          if (drag) return;
          map.current?.pointer(null);
          setHover(null);
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          // Sin esto el navegador selecciona texto y arrastra la selección.
          e.preventDefault();
          dragged.current = false;
          const id = map.current?.pointer(local(e));
          press.current = id && here?.children.some((c) => c.id === id) ? { x: e.clientX, y: e.clientY, id } : null;
        }}
        onClick={(e) => {
          // Soltar después de arrastrar no cuenta como clic.
          if (dragged.current) return;
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
            <button
              data-crumb={i}
              className={`smap-crumb${i === path.length - 1 ? ' current' : ''}${drag?.target?.id === 'crumb:' + n.id ? ' drop' : ''}`}
              onClick={() => i < path.length - 1 && map.current?.upTo(i)}
              onDoubleClick={() => n.kind === 'zone' && onAction('rename', n)}
              title={n.kind === 'zone' ? 'Doble clic para renombrar' : undefined}
            >
              {n.title}
            </button>
          </span>
        ))}
      </nav>
      {drag && (
        <div className="smap-ghost" style={{ left: drag.x - (host.current?.getBoundingClientRect().left ?? 0), top: drag.y - (host.current?.getBoundingClientRect().top ?? 0) }}>
          {drag.node.title}
          {drag.target && <span className="meta"> → {drag.target.id.startsWith('crumb:') ? path.find((n) => 'crumb:' + n.id === drag.target!.id)?.title : here?.children.find((c) => c.id === drag.target!.id)?.title}</span>}
        </div>
      )}
    </div>
  );
}
