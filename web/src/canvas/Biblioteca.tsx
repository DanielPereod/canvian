import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { NoteRow } from '../api';
import { actionFor, keysBlocked, type ActionId } from '../keys';
import { importanceOf, parentMap } from './sections';
import { LOOSE } from './NodeView';
import type { MapAction } from './SectionMap';

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

const STATUS: Record<string, string> = { todo: 'Tarea pendiente', doing: 'Tarea en curso', blocked: 'Tarea bloqueada', done: 'Tarea hecha' };
export function kindOf(r: NoteRow, kids: number) {
  if (r.kind === 'task' || r.kind === 'quick') return STATUS[r.status ?? 'todo'];
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

type SideProps = {
  profileName: string;
  family: Family;
  view: BibView;
  // Lo que se ve: la colección de la biblioteca o la nota abierta (nada en tareas).
  here: string | null | undefined;
  tasks: number;
  showArchived: boolean;
  onProfiles: () => void;
  onSettings: () => void;
  onLibrary: (id: string | null) => void;
  onOpen: (id: string) => void;
  onTasks: () => void;
  onOrganize: () => void;
  onArchived: () => void;
  onNewCollection: () => void;
};

export function BibSidebar(p: SideProps) {
  const { kids, count, pathTo } = p.family;
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(read(OPEN_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      write(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  // Lo que estás viendo siempre tiene abierta su rama.
  const trail = useMemo(() => new Set(pathTo(p.here ?? null).map((r) => r.id)), [pathTo, p.here]);

  const roots = kids.get(null) ?? [];
  const branches = roots.filter((r) => count(r.id)).sort((a, b) => count(b.id) - count(a.id) || titleOf(a).localeCompare(titleOf(b)));
  const loose = roots.filter((r) => !count(r.id) && r.kind !== 'quick');

  const rows: { row: NoteRow; depth: number }[] = [];
  const walk = (r: NoteRow, depth: number) => {
    rows.push({ row: r, depth });
    if (!count(r.id) || !(open.has(r.id) || trail.has(r.id))) return;
    const list = [...(kids.get(r.id) ?? [])].sort((a, b) => count(b.id) - count(a.id) || titleOf(a).localeCompare(titleOf(b)));
    for (const k of list) walk(k, depth + 1);
  };
  for (const r of branches) walk(r, 0);

  const libraryOn = p.view === 'library' || p.view === 'note';
  return (
    <aside className="bib-side" aria-label="Biblioteca">
      <div className="bib-side-top">
        <button className="bib-profile" onClick={p.onProfiles} title="Cambiar de perfil (Ctrl Alt P)">
          <span className="bib-profile-dot" aria-hidden="true" />
          <span className="bib-ellipsis">{p.profileName}</span>
        </button>
        <button className="bib-icon" onClick={p.onSettings} title="Configuración (Ctrl ,)" aria-label="Configuración">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
        </button>
      </div>
      <div className="bib-side-label">Biblioteca</div>
      <button className={`bib-it${libraryOn && p.here === null ? ' is-on' : ''}`} onClick={() => p.onLibrary(null)}>
        <span className="bib-it-i">◎</span>Todas las notas<span className="bib-it-k">Ctrl G</span>
      </button>
      <button className={`bib-it${p.view === 'tasks' ? ' is-on' : ''}`} onClick={p.onTasks}>
        <span className="bib-it-i">☐</span>Tareas<span className="bib-it-k">{p.tasks || ''}</span>
      </button>
      <button className={`bib-it${p.view === 'organize' ? ' is-on' : ''}`} onClick={p.onOrganize}>
        <span className="bib-it-i">⇅</span>Ordenar<span className="bib-it-k">O</span>
      </button>
      <button className={`bib-it${p.showArchived ? ' is-on' : ''}`} onClick={p.onArchived} title="Ctrl Mayús H">
        <span className="bib-it-i">⌫</span>
        {p.showArchived ? 'Ocultar archivadas' : 'Archivadas'}
      </button>
      <div className="bib-side-label">Colecciones</div>
      <div className="bib-tree">
        {rows.map(({ row, depth }) => {
          const n = count(row.id);
          const shut = !(open.has(row.id) || trail.has(row.id));
          const on = p.here === row.id;
          return (
            <div key={row.id} className="bib-tree-row" style={{ paddingLeft: depth * 14 } as CSSProperties}>
              <button className="bib-chev" onClick={() => n && toggle(row.id)} aria-label={n ? (shut ? 'Desplegar' : 'Plegar') : undefined} tabIndex={n ? 0 : -1}>
                {n ? (shut ? '▸' : '▾') : ''}
              </button>
              <button
                className={`bib-it bib-tree-it${on ? ' is-on' : ''}${trail.has(row.id) || depth === 0 ? ' is-near' : ''}`}
                onClick={() => (n ? p.onLibrary(row.id) : p.onOpen(row.id))}
              >
                <span className="bib-ellipsis">{titleOf(row)}</span>
                <span className="bib-it-k">{n || ''}</span>
              </button>
            </div>
          );
        })}
        {loose.length > 0 && (
          <div className="bib-tree-row">
            <span className="bib-chev" />
            <button className={`bib-it bib-tree-it is-near${p.here === LOOSE ? ' is-on' : ''}`} onClick={() => p.onLibrary(LOOSE)}>
              <span className="bib-ellipsis">Sueltas</span>
              <span className="bib-it-k">{loose.length}</span>
            </button>
          </div>
        )}
      </div>
      <button className="bib-it bib-side-new" onClick={p.onNewCollection}>
        ＋ Colección nueva
      </button>
    </aside>
  );
}

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
};

export function BibBar(p: BarProps) {
  return (
    <header className="bib-bar">
      <nav className="bib-crumbs" aria-label="Ruta">
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
};

const KEYS: Partial<Record<ActionId, MapAction>> = { toggleTask: 'task', cycleStatus: 'status', blockTask: 'block', properties: 'props', deleteCell: 'delete', rename: 'rename', archive: 'archive' };
const LIB_ACTIONS: ActionId[] = ['toggleTask', 'cycleStatus', 'blockTask', 'properties', 'deleteCell', 'rename', 'archive', 'toRoot', 'newNote', 'newSection'];

export function Library(p: LibProps) {
  const { kids, count, byId, parent } = p.family;
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
    list = list.filter((r) => r.kind !== 'quick' && (!p.hide || !p.lit || p.lit.has(r.id)));
    const weight = (r: NoteRow) => importanceOf(r, degree.get(r.id) ?? 0) + Math.min(8, count(r.id)) * 0.6;
    // Arriba, las colecciones; después, por importancia.
    return [...list].sort((a, b) => Number(!!count(b.id)) - Number(!!count(a.id)) || weight(b) - weight(a));
  }, [p.center, p.hide, p.lit, kids, count, here, degree]);

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
          {items.length === 1 ? '1 nota' : `${items.length} notas`} · ordenadas por importancia
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
                className={`bib-row${i === at ? ' is-sel' : ''}${dim ? ' is-dim' : ''}`}
                style={{ '--i': Math.min(i, 20), '--h': hueOf(r.id) } as CSSProperties}
                onMouseEnter={() => setSel(i)}
                onClick={() => enter(r)}
              >
                <Spine row={r} kids={n} />
                <span className="bib-row-main">
                  <span className="bib-row-t">{titleOf(r)}</span>
                  <span className="bib-row-s">{snippetOf(r) || (n ? `${n} notas dentro` : 'Sin texto todavía.')}</span>
                </span>
                <span>
                  <span className={`bib-pill${r.status === 'doing' && r.kind !== 'text' ? ' is-accent' : ''}`}>{kind}</span>
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
                className={`bib-cover-it${i === at ? ' is-sel' : ''}${dim ? ' is-dim' : ''}`}
                style={{ '--i': Math.min(i, 20), '--h': hueOf(r.id) } as CSSProperties}
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

// El lomo de cada fila: la cuenta de una colección o la casilla de una tarea.
function Spine({ row, kids }: { row: NoteRow; kids: number }) {
  const task = row.kind === 'task' || row.kind === 'quick';
  const glyph = task ? (row.status === 'done' ? '■' : row.status === 'doing' ? '◧' : row.status === 'blocked' ? '⊘' : '□') : kids ? String(kids) : '';
  return (
    <span className={`bib-spine${kids ? ' is-branch' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  );
}
