import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { COLORS, ROOT_KEY, setColor, setOrder, sortByOrder, useSidebarPrefs } from './sidebarPrefs';
import type { NoteRow } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { importanceOf, parentMap } from './sections';
import { taskCount } from './tasks';
import { LOOSE, type MapAction } from './NodeView';
import { Resizer, type SideWidth } from './Resizer';

// Diseño «Biblioteca»: la app como una biblioteca de investigación. A la
// izquierda, la barra con el perfil, las vistas y el árbol de colecciones;
// arriba, la ruta y el buscador; en el centro, las notas de la colección en
// lista o en portadas (o los nodos de siempre).

export type BibView = 'library' | 'note' | 'tasks' | 'organize';
export type BibLayout = 'lista' | 'portadas' | 'nodos';

const LAYOUT_KEY = 'canvian.bibLayout';
const OPEN_KEY = 'canvian.bibOpen';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Sin almacenamiento local se olvida al recargar; nada más.
  }
};

const FOLD_KEY = 'canvian.bibFolded';
// Barra lateral plegada: no ocupa sitio y sale flotando al acercar el ratón al borde.
export function useBibFolded() {
  const [folded, setFolded] = useState(() => read(FOLD_KEY) === '1');
  const toggle = () =>
    setFolded((v) => {
      write(FOLD_KEY, v ? '0' : '1');
      return !v;
    });
  return [folded, toggle] as const;
}

export function useBibLayout() {
  const [layout, setLayout] = useState<BibLayout>(() => {
    const v = read(LAYOUT_KEY);
    return v === 'portadas' || v === 'nodos' ? v : 'lista';
  });
  return [layout, (l: BibLayout) => (setLayout(l), write(LAYOUT_KEY, l))] as const;
}

// Madre, hijas y cuentas de todas las notas, una vez por cambio.
export function useFamily(rows: NoteRow[]) {
  return useMemo(() => {
    const parent = parentMap(rows);
    const kids = new Map<string | null, NoteRow[]>();
    for (const r of rows) {
      const p = parent.get(r.id) ?? null;
      const list = kids.get(p);
      if (list) list.push(r);
      else kids.set(p, [r]);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const count = (id: string) => kids.get(id)?.length ?? 0;
    const pathTo = (id: string | null) => {
      const out: NoteRow[] = [];
      for (let z = id ? byId.get(id) : undefined; z; z = byId.get(parent.get(z.id) ?? '')) out.unshift(z);
      return out;
    };
    return { parent, kids, byId, count, pathTo };
  }, [rows]);
}
type Family = ReturnType<typeof useFamily>;

export const titleOf = (r: NoteRow | null | undefined) => (r?.kind === 'canvas' ? r.title || 'Canvas sin título' : r?.title || 'Nota sin título');

export function kindOf(r: NoteRow, kids: number) {
  if (r.kind === 'canvas') return 'Canvas';
  return kids ? 'Colección' : 'Nota';
}

// El texto de la nota sin su título, para el resumen.
export const snippetOf = (r: NoteRow) => {
  const lines = (r.bodyText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.title && lines[0] === r.title) lines.shift();
  return lines.join(' · ');
};

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
export function editedLabel(at: string | null) {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `hoy, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

// Cada colección tiene su tapa de un color suave y estable.
const hueOf = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

// ── Barra lateral ─────────────────────────────────────────────────────

// El color de cada nota: el que le hayas puesto o uno estable según su id.
export const tintOf = (colors: Record<string, string>, id: string) => colors[id] ?? null;
const dotStyle = (colors: Record<string, string>, id: string, depth: number): CSSProperties =>
  ({ '--h': hueOf(id), ...(colors[id] ? { '--tint': colors[id] } : {}), '--depth': depth }) as CSSProperties;

// Arrastrar notas: desde la barra o desde la biblioteca.
export const DRAG_TYPE = 'application/x-canvian-note';
type Drop = { id: string | null; pos: 'before' | 'after' | 'inside' };

type SideProps = {
  profileName: string;
  family: Family;
  view: BibView;
  // Lo que se ve: la colección de la biblioteca o la nota abierta (nada en tareas).
  here: string | null | undefined;
  tasks: number;
  showArchived: boolean;
  folded: boolean;
  width: SideWidth;
  onFold: () => void;
  onProfiles: () => void;
  onSettings: () => void;
  onLibrary: (id: string | null) => void;
  onOpen: (id: string) => void;
  onTasks: () => void;
  onOrganize: () => void;
  onArchived: () => void;
  onNewCollection: () => void;
  onMove: (id: string, parent: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
};

const byDefault = (count: (id: string) => number) => (a: NoteRow, b: NoteRow) => count(b.id) - count(a.id) || titleOf(a).localeCompare(titleOf(b), 'es');

export function BibSidebar(p: SideProps) {
  const { kids, count, pathTo, parent } = p.family;
  const prefs = useSidebarPrefs();
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(read(OPEN_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  // Lo que estás viendo siempre tiene abierta su rama.
  const trail = useMemo(() => new Set(pathTo(p.here ?? null).map((r) => r.id)), [pathTo, p.here]);
  // …salvo que la pliegues tú; al ir a otra nota vuelve a abrirse su rama.
  const [shutTrail, setShutTrail] = useState<Set<string>>(() => new Set());
  useEffect(() => setShutTrail(new Set()), [p.here]);
  const isOpen = (id: string) => open.has(id) || (trail.has(id) && !shutTrail.has(id));
  const toggle = (id: string) => {
    const opening = !isOpen(id);
    setOpen((s) => {
      const next = new Set(s);
      if (opening) next.add(id);
      else next.delete(id);
      write(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
    setShutTrail((s) => {
      const next = new Set(s);
      if (opening) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fallback = byDefault(count);
  const kidsOf = (id: string | null) => sortByOrder(id, kids.get(id) ?? [], fallback, prefs);
  const roots = kids.get(null) ?? [];
  const branches = sortByOrder(null, roots.filter((r) => count(r.id)), fallback, prefs);
  const loose = roots.filter((r) => !count(r.id));

  // ── Arrastrar y soltar ──
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const inside = (target: string | null, id: string) => {
    for (let z = target; z; z = parent.get(z) ?? null) if (z === id) return true;
    return false;
  };
  const draggedId = (e: React.DragEvent) => dragId ?? (e.dataTransfer.types.includes(DRAG_TYPE) ? '?' : null);
  const onRowOver = (e: React.DragEvent, id: string) => {
    const moving = draggedId(e);
    if (!moving) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - box.top) / box.height;
    const pos: Drop['pos'] = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
    // Nada puede ir dentro de sí misma ni de lo que cuelga de ella.
    const into = pos === 'inside' ? id : (parent.get(id) ?? null);
    if (moving !== '?' && (moving === id || inside(into, moving))) {
      setDrop(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  };
  const onDropHere = (e: React.DragEvent) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData(DRAG_TYPE);
    const target = drop;
    setDrop(null);
    setDragId(null);
    if (!id || !target) return;
    if (target.pos === 'inside') {
      if (target.id !== null && parent.get(id) !== target.id) {
        p.onMove(id, target.id);
        setOpen((s) => new Set(s).add(target.id!));
      }
      return;
    }
    // Antes o después de otra: pasa a ser su hermana, en ese sitio.
    const into = target.id ? (parent.get(target.id) ?? null) : null;
    if ((parent.get(id) ?? null) !== into) p.onMove(id, into);
    const siblings = (into === null ? branches : kidsOf(into)).map((r) => r.id).filter((x) => x !== id);
    const at = siblings.indexOf(target.id!);
    siblings.splice(target.pos === 'before' ? at : at + 1, 0, id);
    void setOrder(into, siblings).catch(() => {});
  };
  const dropClass = (id: string | null) => (drop && drop.id === id ? ` is-drop-${drop.pos}` : '');

  const renderRow = (row: NoteRow, depth: number): ReactNode => {
    const n = count(row.id);
    const shut = !isOpen(row.id);
    const on = p.here === row.id;
    return (
      <div key={row.id} className="bib-node" role="treeitem" aria-expanded={n ? !shut : undefined} aria-selected={on}>
        <div
          className={`bib-tree-row${on ? ' is-on' : ''}${dragId === row.id ? ' is-dragging' : ''}${dropClass(row.id)}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, row.id);
            e.dataTransfer.effectAllowed = 'move';
            setDragId(row.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDrop(null);
          }}
          onDragOver={(e) => onRowOver(e, row.id)}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop((d) => (d?.id === row.id ? null : d));
          }}
          onDrop={onDropHere}
          onContextMenu={(e) => {
            e.preventDefault();
            p.onMenu(row.id, e.clientX, e.clientY);
          }}
        >
          <button className={`bib-chev${n ? '' : ' is-leaf'}${shut ? '' : ' is-open'}`} onClick={() => n && toggle(row.id)} aria-label={n ? (shut ? 'Desplegar' : 'Plegar') : undefined} tabIndex={-1}>
            <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
              <path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="bib-tree-it" onClick={() => (n ? p.onLibrary(row.id) : p.onOpen(row.id))} title={titleOf(row)}>
            <span className={`bib-dot${depth ? ' is-sub' : ''}`} style={dotStyle(prefs.colors, row.id, depth)} aria-hidden="true" />
            <span className="bib-ellipsis">{titleOf(row)}</span>
            {n > 0 && <span className="bib-count">{n}</span>}
          </button>
        </div>
        {n > 0 && !shut && (
          <div className="bib-branch" role="group">
            {kidsOf(row.id).map((k) => renderRow(k, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const libraryOn = p.view === 'library' || p.view === 'note';
  return (
    <div className={`bib-dock${p.folded ? ' is-folded' : ''}`}>
      {p.folded && <div className="bib-hot" aria-hidden="true" />}
      <aside className="bib-side" aria-label="Biblioteca">
        <div className="bib-side-top">
          <button className="bib-profile" onClick={p.onProfiles} title="Cambiar de perfil (Ctrl Alt P)">
            <span className="bib-profile-dot" aria-hidden="true" />
            <span className="bib-ellipsis">{p.profileName}</span>
            <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true" className="bib-profile-chev">
              <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="bib-icon" onClick={p.onFold} title={p.folded ? 'Fijar la barra (Ctrl .)' : 'Plegar la barra (Ctrl .)'} aria-label={p.folded ? 'Fijar la barra' : 'Plegar la barra'}>
            <PanelIcon />
          </button>
        </div>
        <nav className="bib-nav">
          <button className={`bib-it${libraryOn && p.here === null ? ' is-on' : ''}`} onClick={() => p.onLibrary(null)} title="Ctrl G">
            Todas las notas
          </button>
          <button className={`bib-it${p.view === 'tasks' ? ' is-on' : ''}`} onClick={p.onTasks} title="A">
            Tareas<span className="bib-count">{p.tasks || ''}</span>
          </button>
          <button className={`bib-it${p.view === 'organize' ? ' is-on' : ''}`} onClick={p.onOrganize} title="O">
            Ordenar
          </button>
          <button className={`bib-it${p.showArchived ? ' is-on' : ''}`} onClick={p.onArchived} title="Ctrl Mayús H">
            {p.showArchived ? 'Ocultar archivadas' : 'Archivadas'}
          </button>
        </nav>
        <div
          className={`bib-side-label${drop && drop.id === null ? ' is-drop-inside' : ''}`}
          onDragOver={(e) => {
            if (!draggedId(e)) return;
            e.preventDefault();
            if (drop?.id !== null || drop.pos !== 'inside') setDrop({ id: null, pos: 'inside' });
          }}
          onDragLeave={() => setDrop((d) => (d?.id === null ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            const id = dragId ?? e.dataTransfer.getData(DRAG_TYPE);
            setDrop(null);
            setDragId(null);
            if (id && parent.get(id)) p.onMove(id, null);
          }}
          title="Suelta aquí para sacar una nota arriba del todo"
        >
          Mi biblioteca
          <button className="bib-label-add" onClick={p.onNewCollection} title="Colección nueva" aria-label="Colección nueva">
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="bib-tree" role="tree" aria-label="Colecciones">
          {branches.map((r) => renderRow(r, 0))}
          {loose.length > 0 && (
            <div className="bib-node">
              <div className={`bib-tree-row${p.here === LOOSE ? ' is-on' : ''}`}>
                <span className="bib-chev is-leaf" />
                <button className="bib-tree-it" onClick={() => p.onLibrary(LOOSE)}>
                  <span className="bib-dot is-loose" aria-hidden="true" />
                  <span className="bib-ellipsis">Sueltas</span>
                  <span className="bib-count">{loose.length}</span>
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="bib-side-foot">
          <button className="bib-it bib-side-new" onClick={p.onNewCollection}>
            Colección nueva
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button className="bib-it" onClick={p.onSettings} title="Ctrl ,">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
            Configuración
          </button>
        </div>
      </aside>
      {!p.folded && <Resizer size={p.width} edge="right" className="bib-resizer" />}
    </div>
  );
}

// ── Menú contextual ───────────────────────────────────────────────────

export type MenuAction = 'open' | 'library' | 'nodes' | 'child' | 'rename' | 'move' | 'archive' | 'delete';

type MenuProps = {
  row: NoteRow;
  kids: number;
  x: number;
  y: number;
  onPick: (a: MenuAction) => void;
  onClose: () => void;
};

// Lo común a los menús con clic derecho: dentro de la ventana, el foco en el
// primer botón, ↑↓ entre ellos y se cierra con Esc o al pulsar fuera.
export function useContextMenu(ref: React.RefObject<HTMLDivElement | null>, x: number, y: number, onClose: () => void) {
  const [spot, setSpot] = useState({ x, y });
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

  // Dentro de la ventana siempre, aunque se abra junto al borde.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setSpot({ x: Math.max(8, Math.min(x, innerWidth - box.width - 8)), y: Math.max(8, Math.min(y, innerHeight - box.height - 8)) });
    buttons()[0]?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => {
      const list = buttons();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
      else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  });
  return spot;
}

export function BibMenu({ row, kids, x, y, onPick, onClose }: MenuProps) {
  const prefs = useSidebarPrefs();
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const items: ({ a: MenuAction; label: string; key?: string; danger?: boolean } | null)[] = [
    { a: 'open', label: 'Abrir' },
    ...(kids ? [{ a: 'library' as const, label: 'Ver como colección' }] : []),
    { a: 'nodes', label: 'Ver en nodos', key: 'Ctrl G' },
    null,
    { a: 'child', label: 'Nota nueva dentro', key: 'G' },
    { a: 'rename', label: 'Renombrar', key: 'R' },
    { a: 'move', label: 'Mover a…' },
    null,
    { a: 'archive', label: row.archivedAt ? 'Desarchivar' : 'Archivar', key: 'Ctrl ⇧ X' },
    { a: 'delete', label: 'Borrar', key: 'Supr', danger: true },
  ];

  const color = prefs.colors[row.id] ?? null;
  return (
    <div className="bib-menu" ref={ref} role="menu" aria-label={titleOf(row)} style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="bib-menu-head bib-ellipsis">{titleOf(row)}</div>
      {items.map((it, i) =>
        it ? (
          <button
            key={it.a}
            role="menuitem"
            className={`bib-menu-it${it.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose();
              onPick(it.a);
            }}
          >
            {it.label}
            {it.key && <span className="bib-menu-k">{it.key}</span>}
          </button>
        ) : (
          <div key={`s${i}`} className="bib-menu-sep" role="separator" />
        ),
      )}
      <div className="bib-menu-sep" role="separator" />
      <div className="bib-menu-colors" role="group" aria-label="Color">
        {COLORS.map((c) => (
          <button
            key={c.hex}
            role="menuitemradio"
            aria-checked={color === c.hex}
            className={`bib-swatch${color === c.hex ? ' is-on' : ''}`}
            style={{ '--tint': c.hex } as CSSProperties}
            title={c.name}
            aria-label={c.name}
            onClick={() => void setColor(row.id, c.hex).catch(() => {})}
          />
        ))}
        <button role="menuitemradio" aria-checked={!color} className={`bib-swatch is-auto${!color ? ' is-on' : ''}`} style={{ '--h': hueOf(row.id) } as CSSProperties} title="Automático" aria-label="Color automático" onClick={() => void setColor(row.id, null).catch(() => {})} />
      </div>
    </div>
  );
}

const PanelIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M9.5 5v14" />
  </svg>
);

// ── Cabecera ──────────────────────────────────────────────────────────

type BarProps = {
  crumbs: { id: string | null; title: string }[];
  view: BibView;
  layout: BibLayout;
  onCrumb: (id: string | null) => void;
  onUp: (() => void) | null;
  onSearch: () => void;
  onLayout: (l: BibLayout) => void;
  onNew: () => void;
  folded: boolean;
  onFold: () => void;
};

export function BibBar(p: BarProps) {
  return (
    <header className="bib-bar">
      <nav className="bib-crumbs" aria-label="Ruta">
        {p.folded && (
          <button className="bib-icon bib-unfold" onClick={p.onFold} title="Fijar la barra (Ctrl .)" aria-label="Fijar la barra">
            <PanelIcon />
          </button>
        )}
        <button className="bib-up" onClick={p.onUp ?? undefined} disabled={!p.onUp} aria-label="Subir" title="Subir (Retroceso)">
          ‹
        </button>
        {p.crumbs.map((c, i) => (
          <span key={`${c.id}:${i}`} className="bib-crumb-wrap">
            {i > 0 && <span className="bib-sep">/</span>}
            <button className={`bib-crumb${i === p.crumbs.length - 1 ? ' is-here' : ''}`} onClick={() => p.onCrumb(c.id)}>
              {c.title}
            </button>
          </span>
        ))}
      </nav>
      <button className="bib-search" onClick={p.onSearch}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        Buscar en tu biblioteca
        <span className="bib-search-k">Ctrl P</span>
      </button>
      <div className="bib-bar-end">
        {p.view === 'library' && (
          <div className="bib-seg" role="group" aria-label="Cómo ver la colección">
            {(['lista', 'portadas', 'nodos'] as const).map((l) => (
              <button key={l} className={p.layout === l ? 'is-on' : ''} onClick={() => p.onLayout(l)} aria-pressed={p.layout === l}>
                {l === 'lista' ? 'Lista' : l === 'portadas' ? 'Portadas' : 'Nodos'}
              </button>
            ))}
          </div>
        )}
        <button className="bib-new" onClick={p.onNew} title={p.view === 'tasks' ? 'Tarea nueva (N)' : 'Nota nueva (N)'}>
          {p.view === 'tasks' ? '＋ Tarea' : '＋ Nota'}
        </button>
      </div>
    </header>
  );
}

// ── La colección: lista o portadas ────────────────────────────────────

type LibProps = {
  rows: NoteRow[];
  family: Family;
  links: { source: string; target: string }[];
  center: string | null;
  layout: 'lista' | 'portadas';
  paused: boolean;
  lit: Set<string> | null;
  hide: boolean;
  onCenter: (id: string | null) => void;
  onOpen: (id: string) => void;
  onAction: (action: MapAction, noteId: string | null, parentId: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
};

const KEYS: Partial<Record<ActionId, MapAction>> = { properties: 'props', deleteCell: 'delete', rename: 'rename', archive: 'archive' };
const LIB_ACTIONS: ActionId[] = ['properties', 'deleteCell', 'rename', 'archive', 'toRoot', 'newNote', 'newCanvas', 'newSection'];

export function Library(p: LibProps) {
  const { kids, count, byId, parent } = p.family;
  const prefs = useSidebarPrefs();
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of p.links) {
      d.set(l.source, (d.get(l.source) ?? 0) + 1);
      d.set(l.target, (d.get(l.target) ?? 0) + 1);
    }
    return d;
  }, [p.links]);

  const here = p.center && p.center !== LOOSE ? (byId.get(p.center) ?? null) : null;
  const items = useMemo(() => {
    let list: NoteRow[];
    if (p.center === LOOSE) list = (kids.get(null) ?? []).filter((r) => !count(r.id));
    else list = kids.get(here?.id ?? null) ?? [];
    // Arriba del todo, muchas sueltas taparían las colecciones: van en «Sueltas».
    if (p.center === null && list.some((r) => count(r.id)) && list.filter((r) => !count(r.id)).length > 6) list = list.filter((r) => count(r.id));
    list = list.filter((r) => !p.hide || !p.lit || p.lit.has(r.id));
    const weight = (r: NoteRow) => importanceOf(r, degree.get(r.id) ?? 0) + Math.min(8, count(r.id)) * 0.6;
    // Arriba, las colecciones; después, por importancia (o como las ordenaste en la barra).
    const auto = (a: NoteRow, b: NoteRow) => Number(!!count(b.id)) - Number(!!count(a.id)) || weight(b) - weight(a);
    return p.center === LOOSE ? [...list].sort(auto) : sortByOrder(here?.id ?? null, list, auto, prefs);
  }, [p.center, p.hide, p.lit, kids, count, here, degree, prefs]);
  // Lo común a filas y portadas: color, arrastrar a la barra y menú con clic derecho.
  const itemProps = (r: NoteRow, i: number) => ({
    style: { '--i': Math.min(i, 20), '--h': hueOf(r.id), ...(prefs.colors[r.id] ? { '--tint': prefs.colors[r.id] } : {}) } as CSSProperties,
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, r.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setSel(i);
      p.onMenu(r.id, e.clientX, e.clientY);
    },
  });

  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [p.center]);
  const at = Math.min(sel, Math.max(0, items.length - 1));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
  }, [at, p.layout]);

  const enter = (r: NoteRow) => (count(r.id) ? p.onCenter(r.id) : p.onOpen(r.id));
  const up = () => (p.center === LOOSE || !here ? p.onCenter(null) : p.onCenter(parent.get(here.id) ?? null));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (p.paused || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
      const plain = !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
      const cols = p.layout === 'portadas' ? Math.max(1, Math.round((list.current?.clientWidth ?? 1000) / 200)) : 1;
      const cur = items[at];
      const action = actionFor(e, LIB_ACTIONS);
      if (action && KEYS[action]) {
        if (cur) p.onAction(KEYS[action]!, cur.id, null);
        else if (here) p.onAction(KEYS[action]!, here.id, null);
      } else if (action === 'toRoot') p.onCenter(null);
      else if (action === 'newNote') p.onAction('create', null, here?.id ?? null);
      else if (action === 'newCanvas') p.onAction('createCanvas', null, here?.id ?? null);
      else if (action === 'newSection') p.onAction('section', null, cur?.id ?? here?.id ?? null);
      else if (plain && e.key === 'ArrowDown') setSel(Math.min(items.length - 1, at + cols));
      else if (plain && e.key === 'ArrowUp') setSel(Math.max(0, at - cols));
      else if (plain && e.key === 'ArrowRight' && cols > 1) setSel(Math.min(items.length - 1, at + 1));
      else if (plain && e.key === 'ArrowLeft' && cols > 1) setSel(Math.max(0, at - 1));
      else if (plain && e.key === 'Enter' && cur) enter(cur);
      else if (plain && (e.key === 'Backspace' || e.key === 'Escape') && p.center !== null) up();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const title = p.center === LOOSE ? 'Sueltas' : here ? titleOf(here) : 'Todas las notas';
  const upTitle = here ? p.family.pathTo(parent.get(here.id) ?? null).map(titleOf).join(' / ') || 'Biblioteca' : 'Biblioteca';

  return (
    <div className="bib-lib">
      <div className="bib-lib-head">
        <div className="bib-lib-title">
          <span className="bib-muted bib-small">{upTitle}</span>
          <h1>{title}</h1>
        </div>
        <span className="bib-muted bib-lib-count">
          {items.length === 1 ? '1 nota' : `${items.length} notas`} · {p.center !== LOOSE && prefs.order[here?.id ?? ROOT_KEY]?.length ? 'en tu orden' : 'ordenadas por importancia'}
        </span>
        {here && (
          <button className="bib-link" onClick={() => p.onOpen(here.id)}>
            Abrir «{titleOf(here)}» ↗
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="bib-empty">
          Aquí no hay nada todavía. <kbd>N</kbd> para la primera nota.
        </p>
      )}
      {p.layout === 'lista' ? (
        <div className="bib-table" ref={list} role="list">
          {items.length > 0 && (
            <div className="bib-thead" aria-hidden="true">
              <span />
              <span>Título</span>
              <span>Tipo</span>
              <span>Dentro</span>
              <span className="bib-right">Editada</span>
            </div>
          )}
          {items.map((r, i) => {
            const n = count(r.id);
            const kind = kindOf(r, n);
            const dim = p.lit && !p.lit.has(r.id);
            return (
              <button
                key={r.id}
                role="listitem"
                className={`bib-row${i === at ? ' is-sel' : ''}${dim ? ' is-dim' : ''}${prefs.colors[r.id] ? ' has-tint' : ''}`}
                {...itemProps(r, i)}
                onMouseEnter={() => setSel(i)}
                onClick={() => enter(r)}
              >
                <Spine row={r} kids={n} />
                <span className="bib-row-main">
                  <span className="bib-row-t">{titleOf(r)}</span>
                  <span className="bib-row-s">{snippetOf(r) || (n ? `${n} notas dentro` : 'Sin texto todavía.')}</span>
                </span>
                <span>
                  <span className="bib-pill">{kind}</span>
                </span>
                <span className="bib-muted">{n ? `${n} notas` : '—'}</span>
                <span className="bib-muted bib-right">{editedLabel(r.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bib-covers" ref={list} role="list">
          {items.map((r, i) => {
            const n = count(r.id);
            const kind = kindOf(r, n);
            const dim = p.lit && !p.lit.has(r.id);
            return (
              <button
                key={r.id}
                role="listitem"
                className={`bib-cover-it${i === at ? ' is-sel' : ''}${dim ? ' is-dim' : ''}${prefs.colors[r.id] ? ' has-tint' : ''}`}
                {...itemProps(r, i)}
                onMouseEnter={() => setSel(i)}
                onClick={() => enter(r)}
              >
                <span className={`bib-cover${n ? ' is-branch' : ''}`}>
                  <span className="bib-cover-k">{kind.toUpperCase()}</span>
                  <span className="bib-cover-t">{titleOf(r)}</span>
                  <span className="bib-cover-s">{snippetOf(r) || (n ? `${n} notas dentro` : '')}</span>
                  <span className="bib-cover-lines" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
                <span className="bib-cover-name">{titleOf(r)}</span>
                <span className="bib-muted bib-small">
                  {n ? `${n} notas` : kind} · {editedLabel(r.updatedAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// El lomo de cada fila: la cuenta de una colección o, si tiene tareas, una
// casilla (llena cuando están todas hechas).
function Spine({ row, kids }: { row: NoteRow; kids: number }) {
  const tasks = taskCount(row);
  const glyph = kids ? String(kids) : tasks.total ? (tasks.open.length ? '□' : '■') : '';
  return (
    <span className={`bib-spine${kids ? ' is-branch' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  );
}
