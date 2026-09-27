import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRow } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { importanceOf, parentMap } from './sections';
import type { MapAction } from './SectionMap';

// Vista de nodos: una nota en el centro y, alrededor, lo que tiene que ver con
// ella. Sus hijas en un anillo (unidas con línea), las notas enlazadas en el
// mismo anillo (con línea discontinua), su madre arriba y sus hermanas, más
// tenues, en un arco alrededor de la madre. Clic en un nodo lo trae al centro
// con calma; clic en el del centro (o Enter) abre la nota.

type Props = {
  rows: NoteRow[];
  links: { source: string; target: string }[];
  // Nota del centro; null es la raíz («Todo») y 'loose', las sueltas.
  center: string | null;
  paused: boolean;
  onCenter: (id: string | null) => void;
  onOpen: (id: string) => void;
  onAction: (action: MapAction, noteId: string | null, parentId: string | null) => void;
  onMove: (id: string, parentId: string | null) => void;
  lit: Set<string> | null;
  hide: boolean;
  onLeave?: () => void;
};

type Role = 'center' | 'child' | 'link' | 'more' | 'parent' | 'sibling';
type Placed = { id: string; row: NoteRow | null; title: string; role: Role; x: number; y: number; r: number; kids: number; ring: 1 | 2 };

export const LOOSE = 'loose';
const RING1 = 18;
const RING2 = 28;
const SIBLINGS = 6;
const KEYS: Partial<Record<ActionId, MapAction>> = { toggleTask: 'task', cycleStatus: 'status', blockTask: 'block', properties: 'props', deleteCell: 'delete', rename: 'rename' };
const NODE_ACTIONS: ActionId[] = ['toggleTask', 'cycleStatus', 'blockTask', 'properties', 'deleteCell', 'rename', 'toRoot', 'newNote', 'newSection'];

const titleOf = (r: NoteRow) => r.title || (r.kind === 'task' ? 'Tarea sin título' : 'Nota sin título');

export function NodeView({ rows, links, center, paused, onCenter, onOpen, onAction, onMove, lit, hide, onLeave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [hover, setHover] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: string | null } | null>(null);
  const press = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const parent = useMemo(() => parentMap(rows), [rows]);
  const kids = useMemo(() => {
    const out = new Map<string | null, NoteRow[]>();
    for (const r of rows) {
      const p = parent.get(r.id) ?? null;
      out.set(p, [...(out.get(p) ?? []), r]);
    }
    return out;
  }, [rows, parent]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) {
      d.set(l.source, (d.get(l.source) ?? 0) + 1);
      d.set(l.target, (d.get(l.target) ?? 0) + 1);
    }
    return d;
  }, [links]);
  const weight = (r: NoteRow) => importanceOf(r, degree.get(r.id) ?? 0) + Math.min(8, kids.get(r.id)?.length ?? 0) * 0.6;
  const kidCount = (id: string) => kids.get(id)?.length ?? 0;

  // Arriba del todo, muchas sueltas taparían las ramas: van juntas en «Sueltas».
  const rootKids = kids.get(null) ?? [];
  const rootBranches = rootKids.filter((r) => kidCount(r.id));
  const rootLeaves = rootKids.filter((r) => !kidCount(r.id));
  const grouped = rootBranches.length > 0 && rootLeaves.length > 6;

  const here = center && center !== LOOSE ? (byId.get(center) ?? null) : null;
  const centerId = here ? here.id : center === LOOSE && grouped ? LOOSE : null;

  // Qué se ve y dónde.
  const placed = useMemo<Placed[]>(() => {
    const cx = size.w / 2;
    const cy = size.h / 2 + 20;
    const R1 = Math.max(150, Math.min(size.w * 0.3, size.h * 0.34));
    const R2 = R1 * 1.5;
    const out: Placed[] = [];
    const radius = (r: NoteRow) => 5 + Math.min(9, Math.sqrt(kidCount(r.id)) * 2.4);

    // El centro.
    out.push({
      id: centerId ?? 'root',
      row: here,
      title: here ? titleOf(here) : centerId === LOOSE ? 'Sueltas' : 'Todo',
      role: 'center',
      x: cx,
      y: cy,
      r: 13,
      kids: here ? kidCount(here.id) : 0,
      ring: 1,
    });

    // Hijas (lo más importante primero) y enlazadas que no sean ya hijas.
    let children: NoteRow[];
    if (centerId === LOOSE) children = rootLeaves;
    else if (!here) children = grouped ? rootBranches : rootKids;
    else children = kids.get(here.id) ?? [];
    children = [...children].sort((a, b) => weight(b) - weight(a));
    const up = here ? (parent.get(here.id) ?? null) : null;
    const linked = here
      ? links
          .flatMap((l) => (l.source === here.id ? [l.target] : l.target === here.id ? [l.source] : []))
          .filter((id, i, all) => all.indexOf(id) === i && id !== up && !children.some((c) => c.id === id))
          .map((id) => byId.get(id))
          .filter((r): r is NoteRow => !!r)
      : [];
    const ring: { row: NoteRow | null; role: Role; title?: string; id?: string }[] = children.map((row) => ({ row, role: 'child' as Role }));
    if (!here && grouped) ring.push({ row: null, role: 'child', title: 'Sueltas', id: LOOSE });
    ring.push(...linked.map((row) => ({ row, role: 'link' as Role })));

    // Con madre arriba, el anillo deja libre la parte de arriba. Los ángulos
    // se cuentan en vueltas desde arriba, en el sentido del reloj.
    const hasUp = !!here;
    const first = ring.slice(0, RING1);
    const second = ring.slice(RING1, RING1 + RING2);
    const rest = ring.length - first.length - second.length;
    const arc = (i: number, n: number, rr: number, t0: number, t1: number) => {
      const t = n === 1 ? (t0 + t1) / 2 : t0 + ((t1 - t0) * i) / (n - 1);
      const a = t * Math.PI * 2 - Math.PI / 2;
      return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * 0.86 };
    };
    first.forEach((it, i) => {
      const n = first.length;
      const p = hasUp ? arc(i, n, R1, 0.16, 0.84) : arc(i, n, R1, 0.5 / n, 1 - 0.5 / n);
      const id = it.id ?? it.row!.id;
      out.push({ id, row: it.row, title: it.title ?? titleOf(it.row!), role: it.role, ...p, r: it.row ? radius(it.row) : 9, kids: it.row ? kidCount(it.row.id) : rootLeaves.length, ring: 1 });
    });
    // Lo que no cabe, en un segundo anillo más tenue por abajo.
    second.forEach((it, i) => {
      const p = arc(i, second.length, R2, 0.3, 0.7);
      out.push({ id: it.id ?? it.row!.id, row: it.row, title: it.title ?? titleOf(it.row!), role: it.role, ...p, r: 3.5, kids: it.row ? kidCount(it.row.id) : 0, ring: 2 });
    });
    if (rest > 0) out.push({ id: 'more', row: null, title: `y ${rest} más`, role: 'more', x: cx, y: cy + R2 * 0.86 + 44, r: 0, kids: 0, ring: 2 });

    // Madre arriba y sus otras hijas (las hermanas) en un arco a su alrededor.
    if (here) {
      const upRow = up ? byId.get(up) : undefined;
      const inLoose = !up && grouped && !kidCount(here.id);
      const px = cx;
      const py = cy - R1 * 0.88;
      out.push({ id: upRow ? upRow.id : inLoose ? LOOSE : 'root', row: upRow ?? null, title: upRow ? titleOf(upRow) : inLoose ? 'Sueltas' : 'Todo', role: 'parent', x: px, y: py, r: 7, kids: 0, ring: 1 });
      const sibs = (up ? (kids.get(up) ?? []) : inLoose ? rootLeaves : grouped ? rootBranches : rootKids)
        .filter((r) => r.id !== here.id && !out.some((o) => o.id === r.id))
        .sort((a, b) => weight(b) - weight(a))
        .slice(0, SIBLINGS);
      sibs.forEach((row, i) => {
        const n = sibs.length;
        // Un arco ancho y bajo por encima de la madre, con sitio para los nombres.
        const a = Math.PI * (1.08 + (n === 1 ? 0.42 : (0.84 * i) / (n - 1)));
        out.push({ id: row.id, row, title: titleOf(row), role: 'sibling', x: px + Math.cos(a) * R1 * 1.25, y: py + Math.sin(a) * R1 * 0.3, r: 3, kids: kidCount(row.id), ring: 2 });
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, centerId, here, kids, parent, links, byId, rows]);

  const centerNode = placed[0];
  const navigable = placed.filter((p) => p.role !== 'center' && p.role !== 'more');
  const selected = navigable.find((p) => p.id === sel) ?? null;

  // Al cambiar de centro, nada queda señalado.
  useEffect(() => setSel(null), [centerId]);

  const go = (p: Placed) => {
    if (p.role === 'more') return;
    if (p.role === 'center') {
      if (p.row) onOpen(p.row.id);
      return;
    }
    onCenter(p.id === 'root' ? null : p.id);
  };
  const back = () => {
    if (!centerId) return onLeave?.();
    if (centerId === LOOSE) return onCenter(null);
    const up = parent.get(centerId) ?? null;
    onCenter(up ?? (grouped && !kidCount(centerId) ? LOOSE : null));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
      if (t && t !== document.body && !host.current?.contains(t)) return;
      if (e.key === 'Escape' && (lit || document.querySelector('.inspector, .lantern'))) return;
      const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
      const target = selected ?? (hover ? navigable.find((p) => p.id === hover) : undefined) ?? null;
      const noteOf = (p: Placed | null) => (p?.row ? p.row.id : null);
      const action = actionFor(e, NODE_ACTIONS);
      const ringIds = navigable.filter((p) => p.role === 'child' || p.role === 'link').map((p) => p.id);
      if (action && KEYS[action]) {
        const id = noteOf(target) ?? (here ? here.id : null);
        if (id) onAction(KEYS[action]!, id, null);
      } else if (action === 'toRoot') onCenter(null);
      else if (action === 'newNote') onAction('create', null, here ? here.id : null);
      else if (action === 'newSection') onAction('section', null, noteOf(target) ?? (here ? here.id : null));
      else if (plain && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        if (!ringIds.length) return;
        const i = sel ? ringIds.indexOf(sel) : -1;
        const d = e.key === 'ArrowRight' ? 1 : -1;
        setSel(ringIds[(i + d + ringIds.length) % ringIds.length]);
      } else if (plain && e.key === 'ArrowUp') setSel(navigable.find((p) => p.role === 'parent')?.id ?? null);
      else if (plain && e.key === 'ArrowDown') setSel(ringIds[0] ?? null);
      else if (plain && e.key === 'Enter') go(target ?? centerNode);
      else if (plain && (e.key === 'Escape' || e.key === 'Backspace')) {
        if (sel) setSel(null);
        else back();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Arrastrar un nodo sobre otro lo mete dentro (sobre el centro, en él).
  useEffect(() => {
    const onMoveMouse = (e: MouseEvent) => {
      const p = press.current;
      if (!p) return;
      if (!drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      dragged.current = true;
      const el = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest<SVGGElement>('[data-node]');
      const over = el?.dataset.node ?? null;
      setDrag({ id: p.id, x: e.clientX, y: e.clientY, over: over && over !== p.id ? over : null });
    };
    const onUp = () => {
      const p = press.current;
      press.current = null;
      if (drag?.over && p) {
        const target = placed.find((n) => n.id === drag.over);
        const to = target?.row ? target.row.id : target?.id === 'root' || target?.id === LOOSE ? null : undefined;
        if (to !== undefined) onMove(p.id, to);
      }
      setDrag(null);
    };
    window.addEventListener('mousemove', onMoveMouse);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMoveMouse);
      window.removeEventListener('mouseup', onUp);
    };
  });

  // Ruta de madres del centro, para las migas.
  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: 'Todo' }];
  if (centerId === LOOSE) crumbs.push({ id: LOOSE, title: 'Sueltas' });
  else if (here) {
    const chain: NoteRow[] = [];
    for (let z: NoteRow | undefined = here; z; z = byId.get(parent.get(z.id) ?? '')) chain.unshift(z);
    if (grouped && chain.length === 1 && !kidCount(here.id)) crumbs.push({ id: LOOSE, title: 'Sueltas' });
    crumbs.push(...chain.map((z) => ({ id: z.id, title: titleOf(z) })));
  }

  const dim = (p: Placed) => !!lit && !!p.row && !lit.has(p.row.id);
  const focusOn = hover ?? sel;
  const snippet = here ? (here.bodyText ?? '').split('\n').slice(here.title ? 1 : 0).join(' ').replace(/\s+/g, ' ').trim().slice(0, 140) : '';

  return (
    <div ref={host} className={`nodes${drag ? ' dragging' : ''}${hide && lit ? ' hide-dim' : ''}`}>
      <svg className="nodes-svg" width={size.w} height={size.h}>
        {/* Las líneas van por debajo: cada una se dibuja desde el centro con giro y largo, para que se anime. */}
        {placed.map((p) => {
          if (p.role === 'center' || p.role === 'more') return null;
          const from = p.role === 'sibling' ? placed.find((n) => n.role === 'parent')! : centerNode;
          const dx = p.x - from.x;
          const dy = p.y - from.y;
          const len = Math.hypot(dx, dy);
          const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
          return (
            <line
              key={`l:${p.id}`}
              className={`nodes-line role-${p.role}${focusOn === p.id ? ' on' : ''}${dim(p) ? ' dim' : ''}`}
              x1={0}
              y1={0}
              x2={1}
              y2={0}
              style={{ transform: `translate(${from.x}px, ${from.y}px) rotate(${ang}deg) scaleX(${len})` }}
            />
          );
        })}
        {placed.map((p) => {
          const right = p.x >= centerNode.x - 1;
          const label = p.title.length > 38 ? p.title.slice(0, 37) + '…' : p.title;
          return (
            <g
              key={p.id}
              data-node={p.id}
              className={`nodes-node role-${p.role} ring-${p.ring}${p.kids ? ' has-kids' : ''}${p.row?.kind === 'task' ? ' is-task' : ''}${p.row?.status === 'done' ? ' is-done' : ''}${focusOn === p.id ? ' on' : ''}${drag?.over === p.id ? ' drop' : ''}${dim(p) ? ' dim' : ''}`}
              style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
              onMouseEnter={() => !drag && setHover(p.id)}
              onMouseLeave={() => !drag && setHover(null)}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                dragged.current = false;
                press.current = p.row && p.role !== 'center' ? { id: p.row.id, x: e.clientX, y: e.clientY } : null;
              }}
              onClick={() => !dragged.current && go(p)}
              onDoubleClick={() => p.row && onOpen(p.row.id)}
            >
              {p.role !== 'more' && <circle className="nodes-hit" r={Math.max(p.r + 10, 16)} />}
              {p.role !== 'more' && <circle className="nodes-dot" r={p.r} />}
              {p.role === 'center' ? (
                <>
                  <text className="nodes-title center" y={p.r + 34} textAnchor="middle">
                    {label}
                  </text>
                  {snippet && (
                    <text className="nodes-snippet" y={p.r + 58} textAnchor="middle">
                      {snippet.length > 90 ? snippet.slice(0, 89) + '…' : snippet}
                    </text>
                  )}
                </>
              ) : p.role === 'more' ? (
                <text className="nodes-title more" textAnchor="middle">
                  {label}
                </text>
              ) : p.role === 'sibling' ? (
                <text className="nodes-title" y={-p.r - 8} textAnchor="middle">
                  {p.title.length > 20 ? p.title.slice(0, 19) + '…' : p.title}
                </text>
              ) : p.role === 'parent' ? (
                <text className="nodes-title" y={-p.r - 10} textAnchor="middle">
                  {label}
                </text>
              ) : (
                <text className="nodes-title" x={right ? p.r + 10 : -p.r - 10} y={4} textAnchor={right ? 'start' : 'end'}>
                  {label}
                  {p.kids > 0 && <tspan className="nodes-count"> {p.kids}</tspan>}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <nav className="smap-crumbs">
        {crumbs.map((c, i) => (
          <span key={c.id ?? 'root'} className="smap-crumb-wrap">
            {i > 0 && (
              <span className="smap-sep" aria-hidden="true">
                ›
              </span>
            )}
            <button
              className={`smap-crumb${i === crumbs.length - 1 ? ' current' : ''}`}
              onClick={() => (i < crumbs.length - 1 ? onCenter(c.id) : here && onOpen(here.id))}
              title={i === crumbs.length - 1 && here ? 'Abrir esta nota' : undefined}
            >
              {c.title}
            </button>
          </span>
        ))}
      </nav>
      {!rows.length && (
        <p className="meta nodes-empty">N para la primera nota</p>
      )}
      {drag && (
        <div className="smap-ghost" style={{ left: drag.x - (host.current?.getBoundingClientRect().left ?? 0), top: drag.y - (host.current?.getBoundingClientRect().top ?? 0) }}>
          {byId.get(drag.id) ? titleOf(byId.get(drag.id)!) : ''}
          {drag.over && <span className="meta"> → {placed.find((n) => n.id === drag.over)?.title}</span>}
        </div>
      )}
    </div>
  );
}
