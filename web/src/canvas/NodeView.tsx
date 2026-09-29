import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRow } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { importanceOf, parentMap } from './sections';
import { daysUntil, dueLabel } from './dates';

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
};

type Role = 'center' | 'child' | 'link' | 'more' | 'parent' | 'ancestor' | 'sibling';
type Placed = { id: string; row: NoteRow | null; title: string; role: Role; x: number; y: number; r: number; kids: number; ring: 1 | 2 };

export const LOOSE = 'loose';

// Lo que se pide desde los nodos o la biblioteca sobre la nota señalada (o,
// para crear, dentro de la nota en la que estás).
export type MapAction = 'create' | 'createCanvas' | 'section' | 'task' | 'status' | 'block' | 'props' | 'delete' | 'rename' | 'archive';
const SIBLINGS = 6;
const KEYS: Partial<Record<ActionId, MapAction>> = { toggleTask: 'task', cycleStatus: 'status', blockTask: 'block', properties: 'props', deleteCell: 'delete', rename: 'rename', archive: 'archive' };
const NODE_ACTIONS: ActionId[] = ['toggleTask', 'cycleStatus', 'blockTask', 'properties', 'deleteCell', 'rename', 'archive', 'toRoot', 'newNote', 'newCanvas', 'newSection'];

const ROLE_WORD: Record<Role, string> = { center: 'aquí', child: 'dentro de esta', link: 'enlazada', more: '', parent: 'nota madre', ancestor: 'más arriba', sibling: 'hermana' };

const LEGEND_LINES: [Role, string][] = [
  ['parent', 'madre'],
  ['child', 'dentro'],
  ['sibling', 'hermana'],
  ['link', 'enlazada'],
];

// Curva suave entre dos puntos, en horizontal (ramas) o en vertical (enlaces).
const bend = (x1: number, y1: number, x2: number, y2: number, horiz: boolean) =>
  horiz ? `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}` : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;

// El dibujo de cada nodo dice qué es: tarea (casilla), nota con notas dentro
// (círculo con su cuenta) o nota sola (punto).
function Glyph({ p }: { p: Placed }) {
  const big = p.role === 'center';
  if (p.row?.kind === 'task') {
    const s = big ? 18 : 11;
    const done = p.row.status === 'done';
    return (
      <>
        <rect className={`nodes-task${done ? ' is-done' : ''}`} x={-s / 2} y={-s / 2} width={s} height={s} rx={3} />
        {done && <path className="nodes-check" d={`M${-s * 0.25} 0 l${s * 0.18} ${s * 0.2} l${s * 0.32} ${-s * 0.4}`} />}
      </>
    );
  }
  if (p.kids > 0 && p.role !== 'sibling' && p.role !== 'ancestor') {
    const r = (big ? 14 : 8) + Math.min(6, Math.sqrt(p.kids) * 1.6);
    return (
      <>
        <circle className="nodes-dot is-branch" r={r} />
        <text className="nodes-num" y={3.5} textAnchor="middle">
          {p.kids}
        </text>
      </>
    );
  }
  return <circle className="nodes-dot" r={big ? 9 : p.r} />;
}

const titleOf = (r: NoteRow) => r.title || (r.kind === 'task' ? 'Tarea sin título' : 'Nota sin título');

export function NodeView({ rows, links, center, paused, onCenter, onOpen, onAction, onMove, lit, hide }: Props) {
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

  // Qué se ve y dónde, en árbol: la ruta de madres de izquierda a derecha,
  // la nota en el centro y sus hijas en abanico a la derecha. Las hermanas
  // cuelgan de la madre y las enlazadas, abajo, con arcos discontinuos.
  const placed = useMemo<Placed[]>(() => {
    const out: Placed[] = [];
    const cy = Math.round(size.h / 2);
    const step = Math.max(90, Math.min(150, size.w * 0.12));

    // Ruta: «Todo» (y «Sueltas» si toca), las madres y la nota.
    const chain: { id: string; row: NoteRow | null; title: string }[] = [{ id: 'root', row: null, title: 'Todo' }];
    if (centerId === LOOSE) chain.push({ id: LOOSE, row: null, title: 'Sueltas' });
    else if (here) {
      const up: NoteRow[] = [];
      for (let z: NoteRow | undefined = here; z; z = byId.get(parent.get(z.id) ?? '')) up.unshift(z);
      if (grouped && up.length === 1 && !kidCount(here.id)) chain.push({ id: LOOSE, row: null, title: 'Sueltas' });
      chain.push(...up.map((z) => ({ id: z.id, row: z, title: titleOf(z) })));
    }
    // Arriba del todo solo se ven las dos madres más cercanas; el resto está en las migas.
    const shown = chain.slice(Math.max(0, chain.length - 3));
    const cx = Math.round(Math.max(90 + (shown.length - 1) * step, size.w * 0.34));
    shown.forEach((c, i) => {
      const last = i === shown.length - 1;
      const x = cx - (shown.length - 1 - i) * step;
      out.push({
        id: c.id,
        row: c.row,
        title: c.title,
        role: last ? 'center' : i === shown.length - 2 ? 'parent' : 'ancestor',
        x,
        y: cy,
        r: last ? 13 : 7,
        kids: c.row ? kidCount(c.row.id) : c.id === LOOSE ? rootLeaves.length : rootKids.length,
        ring: 1,
      });
    });
    const parentNode = out.find((p) => p.role === 'parent');

    // Las enlazadas se calculan antes: si una hermana también está enlazada,
    // sale una sola vez, como enlazada (dice más).
    const inChain = new Set(shown.map((c) => c.id));
    const linkedIds = here
      ? links
          .flatMap((l) => (l.source === here.id ? [l.target] : l.target === here.id ? [l.source] : []))
          .filter((id, i, all) => all.indexOf(id) === i && !inChain.has(id) && parent.get(id) !== here.id)
      : [];
    const linkedSet = new Set(linkedIds);

    // Hermanas: en columna bajo la madre, tenues (su nombre queda debajo de la madre).
    if (parentNode) {
      const upId = parentNode.id;
      const pool = upId === 'root' ? (grouped ? rootBranches : rootKids) : upId === LOOSE ? rootLeaves : (kids.get(upId) ?? []);
      const sibs = pool
        .filter((r) => r.id !== centerId && !linkedSet.has(r.id))
        .sort((a, b) => weight(b) - weight(a))
        .slice(0, SIBLINGS);
      sibs.forEach((row, i) => {
        out.push({ id: row.id, row, title: titleOf(row), role: 'sibling', x: parentNode.x, y: cy + 56 + i * 28, r: 3.5, kids: kidCount(row.id), ring: 2 });
      });
    }

    // Hijas en abanico (lo más importante primero), en una o dos columnas.
    let children: NoteRow[];
    if (centerId === LOOSE) children = rootLeaves;
    else if (!here) children = grouped ? rootBranches : rootKids;
    else children = kids.get(here.id) ?? [];
    children = [...children].sort((a, b) => weight(b) - weight(a));
    const ringItems: { row: NoteRow | null; id: string; title: string }[] = children.map((r) => ({ row: r, id: r.id, title: titleOf(r) }));
    if (!here && centerId !== LOOSE && grouped) ringItems.push({ row: null, id: LOOSE, title: 'Sueltas' });
    const perCol = Math.max(4, Math.floor((size.h - 170) / 40));
    const kx = cx + Math.max(150, Math.min(220, size.w * 0.16));
    const colW = Math.max(240, Math.min(320, size.w - kx - 60));
    const cols = ringItems.length > perCol && kx + colW * 2 < size.w ? 2 : 1;
    const fit = perCol * cols;
    const visible = ringItems.slice(0, ringItems.length > fit ? fit - 1 : fit);
    const rows = Math.ceil(visible.length / cols);
    const span = Math.min(size.h - 170, Math.max(0, rows - 1) * 44);
    visible.forEach((it, i) => {
      const col = Math.floor(i / rows);
      const k = i % rows;
      const y = cy - span / 2 + (rows === 1 ? 0 : (span * k) / (rows - 1));
      out.push({ id: it.id, row: it.row, title: it.title, role: 'child', x: kx + col * colW, y, r: it.row ? 5 : 7, kids: it.row ? kidCount(it.row.id) : rootLeaves.length, ring: col ? 2 : 1 });
    });
    const rest = ringItems.length - visible.length;
    if (rest > 0) out.push({ id: 'more', row: null, title: `y ${rest} más`, role: 'more', x: kx, y: cy + span / 2 + 44, r: 0, kids: 0, ring: 2 });

    // Enlazadas: en la columna de la derecha, marcadas como enlazadas.
    const linked = linkedIds
      .map((id) => byId.get(id))
      .filter((r): r is NoteRow => !!r)
      .slice(0, 6);
    // Sin hijas ocupan su columna; con hijas, siguen debajo tras un respiro.
    const top = visible.length ? cy + span / 2 + (rest > 0 ? 88 : 60) : cy - ((Math.min(linked.length, perCol) - 1) / 2) * 34;
    const room = Math.max(1, Math.floor((size.h - 60 - top) / 34) + 1);
    linked.forEach((row, i) => {
      const col = Math.floor(i / room);
      const x = kx + col * colW;
      out.push({ id: row.id, row, title: titleOf(row), role: 'link', x, y: top + (i % room) * 34, r: 4.5, kids: kidCount(row.id), ring: 1 });
    });
    // Siempre con el centro primero.
    const c = out.findIndex((p) => p.role === 'center');
    return [out[c], ...out.filter((_, i) => i !== c)];
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
    if (!centerId) return;
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
      else if (action === 'newCanvas') onAction('createCanvas', null, here ? here.id : null);
      else if (action === 'newSection') onAction('section', null, noteOf(target) ?? (here ? here.id : null));
      else if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // Arriba y abajo recorren las hijas (y después las enlazadas).
        if (!ringIds.length) return;
        const i = sel ? ringIds.indexOf(sel) : -1;
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSel(ringIds[(i + d + ringIds.length) % ringIds.length]);
      } else if (plain && e.key === 'ArrowLeft') setSel(navigable.find((p) => p.role === 'parent')?.id ?? null);
      else if (plain && e.key === 'ArrowRight') setSel(ringIds[0] ?? null);
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
  // Bajo el título del centro: cuánto contiene, sus tareas y sus enlaces.
  const summary = (() => {
    const inside = placed[0]?.kids ?? 0;
    const tasks = here ? (kids.get(here.id) ?? []).filter((r) => r.kind === 'task') : [];
    const doneN = tasks.filter((r) => r.status === 'done').length;
    const linkN = placed.filter((p) => p.role === 'link').length;
    return [inside && `${inside} dentro`, tasks.length && `${doneN}/${tasks.length} tareas`, linkN && `${linkN} enlazada${linkN > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  })();

  return (
    <div ref={host} className={`nodes${drag ? ' dragging' : ''}${hide && lit ? ' hide-dim' : ''}`}>
      <svg className="nodes-svg" width={size.w} height={size.h}>
        {/* Las ramas por debajo: cada relación con su trazo (madre, contiene, hermana, enlace). */}
        {placed.map((p, i) => {
          if (p.role === 'center' || p.role === 'more') return null;
          let d: string;
          if (p.role === 'parent' || p.role === 'ancestor') {
            const next = placed.find((n) => n.y === p.y && n.x > p.x && (n.role === 'parent' || n.role === 'center') && n.x - p.x < 400 && n !== p);
            if (!next) return null;
            d = `M${p.x} ${p.y} L${next.x} ${next.y}`;
          } else if (p.role === 'sibling') {
            const up = placed.find((n) => n.role === 'parent');
            if (!up) return null;
            d = `M${up.x} ${up.y} L${p.x} ${p.y}`;
          } else if (p.role === 'link') {
            d = bend(centerNode.x + centerNode.r + 2, centerNode.y, p.x - p.r - 4, p.y, true);
          } else {
            const from = p.ring === 2 ? { x: p.x - 40, y: p.y } : { x: centerNode.x + centerNode.r + 2, y: centerNode.y };
            d = p.ring === 2 ? `M${from.x} ${p.y} L${p.x - p.r - 4} ${p.y}` : bend(from.x, from.y, p.x - p.r - 4, p.y, true);
          }
          return <path key={`l:${p.id}:${i}`} d={d} className={`nodes-line role-${p.role}${focusOn === p.id ? ' on' : ''}${dim(p) ? ' dim' : ''}${p.row?.archivedAt ? ' is-archived' : ''}`} />;
        })}
        {placed.map((p) => {
          const label = p.title.length > 34 ? p.title.slice(0, 33) + '…' : p.title;
          const task = p.row?.kind === 'task';
          const meta = task ? (p.row!.status === 'done' ? 'hecha' : p.row!.dueAt ? dueLabel(p.row!.dueAt) : '') : p.kids ? `${p.kids} dentro` : '';
          return (
            <g
              key={`${p.role}:${p.id}`}
              data-node={p.id}
              className={`nodes-node role-${p.role} ring-${p.ring}${p.kids ? ' has-kids' : ''}${task ? ' is-task' : ''}${p.row?.status === 'done' ? ' is-done' : ''}${focusOn === p.id ? ' on' : ''}${drag?.over === p.id ? ' drop' : ''}${dim(p) ? ' dim' : ''}${p.row?.archivedAt ? ' is-archived' : ''}`}
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
              <title>{`${p.title} · ${ROLE_WORD[p.role]}`}</title>
              {p.role !== 'more' && <circle className="nodes-hit" r={Math.max(p.r + 10, 16)} />}
              {p.role !== 'more' && <Glyph p={p} />}
              {p.role === 'center' ? (
                <>
                  <text className="nodes-title center" y={-p.r - 34} textAnchor="middle">
                    {label}
                  </text>
                  <text className="nodes-snippet" y={-p.r - 14} textAnchor="middle">
                    {summary}
                  </text>
                </>
              ) : p.role === 'more' ? (
                <text className="nodes-title more" x={-4}>
                  {label}
                </text>
              ) : p.role === 'sibling' ? (
                <text className="nodes-title" x={-p.r - 10} y={4} textAnchor="end">
                  {p.title.length > 22 ? p.title.slice(0, 21) + '…' : p.title}
                </text>
              ) : p.role === 'parent' || p.role === 'ancestor' ? (
                <text className="nodes-title" y={p.r + 20} textAnchor="middle">
                  {p.title.length > 20 ? p.title.slice(0, 19) + '…' : p.title}
                </text>
              ) : p.role === 'link' ? (
                <>
                  <text className="nodes-title" x={p.r + 10} y={0}>
                    {p.title.length > 30 ? p.title.slice(0, 29) + '…' : p.title}
                  </text>
                  <text className="nodes-meta" x={p.r + 10} y={14}>
                    enlazada
                  </text>
                </>
              ) : (
                <>
                  <text className="nodes-title" x={p.r + 10} y={meta ? 0 : 4}>
                    {label}
                  </text>
                  {meta && (
                    <text className={`nodes-meta${task && p.row!.status !== 'done' && p.row!.dueAt && daysUntil(p.row!.dueAt) < 0 ? ' is-late' : ''}`} x={p.r + 10} y={14}>
                      {meta}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
      {/* Leyenda: qué relación dibuja cada trazo y qué es cada forma. */}
      <div className="nodes-legend" aria-label="Leyenda">
        {LEGEND_LINES.map(([role, name]) => (
          <span key={role} className="nodes-legend-item">
            <svg width="26" height="8" aria-hidden="true">
              <path className={`nodes-line role-${role}`} d="M1 4 L25 4" />
            </svg>
            {name}
          </span>
        ))}
        <span className="nodes-legend-item">
          <svg width="12" height="12" aria-hidden="true">
            <rect className="nodes-task" x="1.5" y="1.5" width="9" height="9" rx="2" />
          </svg>
          tarea
        </span>
        <span className="nodes-legend-item">
          <svg width="14" height="14" aria-hidden="true">
            <circle className="nodes-dot is-branch" cx="7" cy="7" r="6" />
          </svg>
          con notas dentro
        </span>
        <span className="nodes-legend-item">
          <svg width="12" height="12" aria-hidden="true">
            <circle className="nodes-dot" cx="6" cy="6" r="3.5" />
          </svg>
          nota
        </span>
      </div>
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
