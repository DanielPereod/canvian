import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRow } from '../api';
import { TaskGlyph } from './TaskGlyph';
import { SectionPicker, type SectionOption } from './SectionPicker';
import { parentMap } from './sections';
import { makeSuggester } from './suggest';
import { actionFor, keysBlocked } from '../keys';

// Otra vista, fuera del mapa: ordenar. A la izquierda el árbol de secciones;
// a la derecha las notas de la elegida. Se marcan varias y se llevan a otra
// sección arrastrando, con M o aceptando la sección que se sugiere.

export const OPEN_ORGANIZE = 'canvian:organize';
export const openOrganize = () => window.dispatchEvent(new Event(OPEN_ORGANIZE));

export type Move = { id: string; zoneId: string | null };

type SortBy = 'reciente' | 'nombre' | 'tipo';
const SORTS: { id: SortBy; label: string }[] = [
  { id: 'reciente', label: 'Recientes' },
  { id: 'nombre', label: 'A–Z' },
  { id: 'tipo', label: 'Tipo' },
];
const KIND_ORDER: Record<string, number> = { task: 0, text: 1, canvas: 2 };
// «Sin sección» en el árbol; las secciones van por su id.
const LOOSE = '';

type Props = {
  rows: NoteRow[];
  sections: SectionOption[];
  paused: boolean;
  onOpen: (id: string) => void;
  onMove: (moves: Move[]) => void;
  onNewSection: (parent: string | null) => void;
  onClose: () => void;
};

type TreeRow = { id: string; zone: NoteRow | null; depth: number; count: number };

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function OrganizeView({ rows, sections, paused, onOpen, onMove, onNewSection, onClose }: Props) {
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  // Las notas con hijas son las ramas del árbol de la izquierda.
  const parent = useMemo(() => parentMap(rows), [rows]);
  const zoneIds = useMemo(() => new Set([...parent.values()].filter((p): p is string => !!p)), [parent]);
  // Dónde está cada cosa: sin madre, arriba del todo.
  const home = (r: NoteRow) => parent.get(r.id) ?? LOOSE;

  // El árbol en orden de lectura, con cuántas notas hay directamente en cada sección.
  const tree = useMemo(() => {
    const kids = new Map<string, NoteRow[]>();
    const count = new Map<string, number>();
    for (const r of rows) {
      const h = home(r);
      if (zoneIds.has(r.id)) kids.set(h, [...(kids.get(h) ?? []), r]);
      count.set(h, (count.get(h) ?? 0) + 1);
    }
    const out: TreeRow[] = [{ id: LOOSE, zone: null, depth: 0, count: count.get(LOOSE) ?? 0 }];
    const seen = new Set<string>();
    const walk = (parent: string, depth: number) => {
      const list = [...(kids.get(parent) ?? [])].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'es'));
      for (const z of list) {
        if (seen.has(z.id)) continue;
        seen.add(z.id);
        out.push({ id: z.id, zone: z, depth, count: count.get(z.id) ?? 0 });
        walk(z.id, depth + 1);
      }
    };
    walk(LOOSE, 0);
    // Secciones en un ciclo (A dentro de B dentro de A): al final, sin sangría.
    for (const z of rows) if (zoneIds.has(z.id) && !seen.has(z.id)) out.push({ id: z.id, zone: z, depth: 0, count: count.get(z.id) ?? 0 });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, zoneIds, parent]);

  // Se empieza por lo que más pide orden: «Sin sección», si tiene algo.
  const [where, setWhere] = useState<string>(() => (tree[0].count || tree.length === 1 ? LOOSE : tree[1].id));
  const here = tree.some((t) => t.id === where) ? where : LOOSE;
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('reciente');
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; moves: Move[] } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const suggest = useMemo(() => makeSuggester(rows), [rows]);
  const nameOf = (id: string | null) => (id ? byId.get(id)?.title || 'Sin nombre' : 'Arriba del todo');

  // Las notas de la sección elegida; buscando, las de todas.
  const q = norm(query.trim());
  const items = useMemo(() => {
    const list = rows.filter((r) => (q ? norm(`${r.title ?? ''} ${r.bodyText ?? ''}`).includes(q) : home(r) === here));
    const t = (r: NoteRow) => (r.updatedAt ? Date.parse(r.updatedAt) : 0);
    if (sortBy === 'nombre') list.sort((a, b) => (a.title || '￿').localeCompare(b.title || '￿', 'es'));
    else if (sortBy === 'tipo') list.sort((a, b) => (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || t(b) - t(a));
    else list.sort((a, b) => t(b) - t(a));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, here, q, sortBy, parent]);

  const hints = useMemo(() => new Map(items.slice(0, 400).map((r) => [r.id, suggest(r)])), [items, suggest]);

  // Lo marcado que ya no está a la vista deja de estarlo.
  const visible = new Set(items.map((r) => r.id));
  const chosen = [...marked].filter((id) => visible.has(id));
  const found = items.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : 0;
  const cur = items[at];

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.org-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 7000);
    return () => clearTimeout(t);
  }, [undo]);

  const goTo = (id: string) => {
    setWhere(id);
    setQuery('');
    setMarked(new Set());
    setCursorId(null);
    anchor.current = null;
  };

  const toggle = (id: string) =>
    setMarked((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Marcar de una a otra (⇧ + clic o ⇧ + flechas).
  const range = (to: string) => {
    const a = items.findIndex((r) => r.id === (anchor.current ?? cur?.id));
    const b = items.findIndex((r) => r.id === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setMarked(new Set(items.slice(lo, hi + 1).map((r) => r.id)));
  };

  const move = (ids: string[], zoneId: string | null) => {
    const moves = ids
      .map((id) => byId.get(id))
      .filter((r): r is NoteRow => !!r && home(r) !== (zoneId ?? LOOSE))
      .map((r) => ({ id: r.id, zoneId }));
    if (!moves.length) return;
    const back = moves.map((m) => ({ id: m.id, zoneId: byId.get(m.id)!.zoneId }));
    onMove(moves);
    setMarked(new Set());
    const n = moves.length;
    setUndo({ text: `${n === 1 ? '1 nota' : `${n} notas`} a ${nameOf(zoneId)}`, moves: back });
  };

  // Lo que se lleva: lo marcado o, si no hay nada, la nota del cursor.
  const targets = () => (chosen.length ? chosen : cur ? [cur.id] : []);

  const acceptHints = (ids: string[]) => {
    const byZone = new Map<string, string[]>();
    for (const id of ids) {
      const z = hints.get(id);
      if (z) byZone.set(z, [...(byZone.get(z) ?? []), id]);
    }
    if (!byZone.size) return;
    const moves: Move[] = [];
    for (const [z, list] of byZone) for (const id of list) moves.push({ id, zoneId: z });
    const back = moves.map((m) => ({ id: m.id, zoneId: byId.get(m.id)!.zoneId }));
    onMove(moves);
    setMarked(new Set());
    setUndo({ text: `${moves.length === 1 ? '1 nota colocada' : `${moves.length} notas colocadas`} donde se sugería`, moves: back });
  };

  const hinted = (chosen.length ? chosen : items.map((r) => r.id)).filter((id) => hints.get(id));

  // ── Arrastrar ───────────────────────────────────────────────────────
  const drag = useRef<string[]>([]);
  const startDrag = (e: React.DragEvent, ids: string[]) => {
    drag.current = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ids.join(' '));
    const ghost = document.createElement('div');
    ghost.className = 'org-ghost';
    ghost.textContent = ids.length === 1 ? (byId.get(ids[0])?.title || 'Nota sin título') : `${ids.length} notas`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove(), 0);
  };
  // Una sección no puede ir dentro de sí misma ni de sus subsecciones.
  const canDrop = (target: string) =>
    drag.current.length > 0 &&
    drag.current.every((id) => {
      for (let z: string | null = target || null; z; z = byId.get(z)?.zoneId ?? null) if (z === id) return false;
      return true;
    });
  const dropOn = (target: string) => {
    const ids = drag.current;
    const ok = canDrop(target);
    drag.current = [];
    setDragOver(null);
    if (!ids.length || !ok) return;
    const zone = byId.get(ids[0]);
    if (ids.length === 1 && zone && zoneIds.has(zone.id)) {
      if (home(zone) === target) return;
      const back = [{ id: zone.id, zoneId: zone.zoneId }];
      onMove([{ id: zone.id, zoneId: target || null }]);
      setUndo({ text: `${zone.title || 'Nota'} dentro de ${nameOf(target || null)}`, moves: back });
    } else move(ids, target || null);
  };

  // ── Teclado ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || picking || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing) {
        if (e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'Enter') {
          e.preventDefault();
          t!.blur();
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.altKey || (mod && e.key.toLowerCase() !== 'a') ? '' : e.key.toLowerCase();
      const action = actionFor(e, ['organize']);
      const step = (d: number) => {
        const next = items[Math.max(0, Math.min(items.length - 1, at + d))];
        if (!next) return;
        if (e.shiftKey) {
          if (!anchor.current) anchor.current = cur?.id ?? null;
          range(next.id);
        } else anchor.current = next.id;
        setCursorId(next.id);
      };
      const idx = tree.findIndex((r) => r.id === here);
      if (k === 'escape') {
        if (chosen.length) setMarked(new Set());
        else if (query) setQuery('');
        else onClose();
      } else if (action === 'organize') onClose();
      else if (k === 'arrowdown' || k === 'j') step(1);
      else if (k === 'arrowup' || k === 'k') step(-1);
      else if (k === 'arrowleft' || k === 'h') idx > 0 && goTo(tree[idx - 1].id);
      else if (k === 'arrowright' || k === 'l') idx < tree.length - 1 && goTo(tree[idx + 1].id);
      else if (k === ' ' || k === 'x') cur && toggle(cur.id);
      else if (k === 'a' && mod) setMarked(chosen.length === items.length ? new Set() : new Set(items.map((r) => r.id)));
      else if (k === 'm') targets().length && setPicking(true);
      else if (k === 's') acceptHints(targets());
      else if (k === 'enter') cur && onOpen(cur.id);
      else if (k === '/') searchRef.current?.focus();
      else if (k === 'g') onNewSection(here || null);
      else if (k === 'z' && undo) {
        onMove(undo.moves);
        setUndo(null);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const title = q ? 'Buscando en todas' : here ? nameOf(here) : 'Arriba del todo';
  const pathOf = (r: NoteRow) => sections.find((s) => s.id === (home(r) || null))?.path ?? 'Arriba del todo';

  return (
    <div className="org-view">
      <header className="tasks-top">
        <button className="sheet-back meta" onClick={onClose}>
          ← Mapa
        </button>
        <nav className="tasks-group-by" aria-label="Ordenar la lista">
          {SORTS.map((s) => (
            <button key={s.id} className={`meta${s.id === sortBy ? ' is-on' : ''}`} onClick={() => setSortBy(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="org-body">
        <aside className="org-tree" aria-label="Secciones">
          <h1 className="display org-title">
            <em>Ordenar</em>
          </h1>
          <ul>
            {tree.map((t, i) => (
              <li
                key={t.id || 'loose'}
                className={`org-branch${t.id === here && !q ? ' is-here' : ''}${dragOver === t.id ? ' is-over' : ''}${t.id ? '' : ' is-loose'}`}
                style={{ '--depth': t.depth, '--i': Math.min(i, 20) } as React.CSSProperties}
                draggable={!!t.zone}
                onDragStart={(e) => t.zone && startDrag(e, [t.zone.id])}
                onDragEnd={() => {
                  drag.current = [];
                  setDragOver(null);
                }}
                onDragOver={(e) => {
                  if (!canDrop(t.id)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOver(t.id);
                }}
                onDragLeave={() => setDragOver((d) => (d === t.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(t.id);
                }}
                onClick={() => goTo(t.id)}
              >
                <span className="org-branch-name">{t.zone ? t.zone.title || 'Sin nombre' : 'Arriba del todo'}</span>
                <span className="meta">{t.count || ''}</span>
              </li>
            ))}
          </ul>
          <button className="sheet-link sheet-link-add org-new" onClick={() => onNewSection(here || null)}>
            + Nota{here ? ` en ${nameOf(here)}` : ''}
          </button>
        </aside>

        <section className="org-list" ref={listRef}>
          <div className="org-head">
            <h2 className="tasks-group-title">
              {title} <span className="meta">{items.length}</span>
            </h2>
            <input
              ref={searchRef}
              className="field org-search"
              placeholder="Buscar en todas…  /"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMarked(new Set());
              }}
            />
          </div>
          <p className="meta org-help">Clic marca · arrastra a otra nota · M mover · S sugerida · ← → ramas</p>
          {!items.length && (
            <p className="tasks-empty">{q ? 'Nada coincide.' : here ? 'Aquí dentro no hay nada.' : 'Todo tiene su sitio.'}</p>
          )}
          {items.map((r, idx) => {
            const hint = hints.get(r.id);
            const on = marked.has(r.id);
            return (
              <div
                key={r.id}
                className={`org-row${idx === at ? ' is-cursor' : ''}${on ? ' is-marked' : ''}`}
                style={{ '--i': Math.min(idx, 20) } as React.CSSProperties}
                draggable
                onDragStart={(e) => startDrag(e, on && chosen.length ? chosen : [r.id])}
                onDragEnd={() => {
                  drag.current = [];
                  setDragOver(null);
                }}
                onMouseEnter={() => setCursorId(r.id)}
                onClick={(e) => {
                  if (e.shiftKey) range(r.id);
                  else {
                    anchor.current = r.id;
                    toggle(r.id);
                  }
                }}
                onDoubleClick={() => onOpen(r.id)}
              >
                <span className={`org-check${on ? ' is-on' : ''}`} aria-hidden="true" />
                {r.kind === 'task' ? (
                  <TaskGlyph status={r.status ?? 'todo'} ripe={false} onCycle={() => {}} />
                ) : (
                  <span className={`org-kind org-kind-${r.kind}`} aria-hidden="true" />
                )}
                <span className="org-row-title">{r.title || (r.kind === 'task' ? 'Tarea sin título' : 'Nota sin título')}</span>
                {q && <span className="meta tasks-where">{pathOf(r)}</span>}
                {hint && (
                  <button
                    className="meta org-hint"
                    title="Llevarla a donde se sugiere (S)"
                    onClick={(e) => {
                      e.stopPropagation();
                      move([r.id], hint);
                    }}
                  >
                    → {nameOf(hint)}
                  </button>
                )}
                <button
                  className="meta org-open"
                  title="Abrir (Enter)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(r.id);
                  }}
                >
                  abrir
                </button>
              </div>
            );
          })}
        </section>
      </div>

      <footer className={`surface-3 org-bar${chosen.length || undo || hinted.length ? ' is-up' : ''}`} role="status">
        {undo && !chosen.length ? (
          <>
            <span>{undo.text}</span>
            <button
              className="sheet-link"
              onClick={() => {
                onMove(undo.moves);
                setUndo(null);
              }}
            >
              Deshacer <span className="meta">Z</span>
            </button>
          </>
        ) : (
          <>
            {chosen.length > 0 ? (
              <>
                <span>{chosen.length === 1 ? '1 marcada' : `${chosen.length} marcadas`}</span>
                <button className="sheet-link" onClick={() => setPicking(true)}>
                  Mover a… <span className="meta">M</span>
                </button>
              </>
            ) : (
              <span>{hinted.length === 1 ? '1 nota tiene' : `${hinted.length} notas tienen`} un sitio sugerido</span>
            )}
            {hinted.length > 0 && (
              <button className="sheet-link" onClick={() => acceptHints(hinted)}>
                Colocar {hinted.length === 1 ? 'la sugerida' : `las ${hinted.length} sugeridas`} <span className="meta">S</span>
              </button>
            )}
            {chosen.length > 0 && (
              <button className="sheet-link faint" onClick={() => setMarked(new Set())}>
                Desmarcar
              </button>
            )}
          </>
        )}
      </footer>

      {picking && (
        <SectionPicker
          options={sections}
          current={here || null}
          onPick={(zoneId) => {
            setPicking(false);
            move(targets(), zoneId);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
