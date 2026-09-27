import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, type NoteRow, type SearchHit } from '../api';
import { parentMap, pathText, resolvePath, routeText } from './sections';

type Props = {
  profileId: string;
  onPick: (id: string) => void;
  onCreate: (text: string) => void;
  onClose: () => void;
  placeholder?: string;
  // Nota que no se ofrece (la abierta, al enlazar o añadir al canvas).
  exclude?: string;
  // Con estas dos, «Padre>Hijo>Nota» busca dentro de esa ruta y Enter crea ahí.
  rows?: NoteRow[];
  onCreatePath?: (zoneId: string | null, sections: string[], title: string) => void;
};

type Item = { kind: 'note'; hit: SearchHit } | { kind: 'create'; text: string } | { kind: 'path'; text: string };

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function snippet(hit: SearchHit): string {
  const body = (hit.bodyText ?? '').replace(/\s+/g, ' ').trim();
  const rest = hit.title && body.startsWith(hit.title) ? body.slice(hit.title.length).trim() : body;
  return rest.slice(0, 90);
}

export function CommandPalette({ profileId, onPick, onCreate, onClose, placeholder = 'Buscar notas o crear una · > para rutas', exclude, rows, onCreatePath }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  // La búsqueda del servidor no sabe de archivadas: se queda solo con las que se ven.
  const visible = useRef<Set<string> | null>(null);
  visible.current = rows ? new Set(rows.map((r) => r.id)) : null;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(profileId, query).then(
        (rows) => {
          if (cancelled) return;
          setHits(visible.current ? rows.filter((h) => visible.current!.has(h.id)) : rows);
          setCursor(0);
        },
        () => !cancelled && setHits([]),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [profileId, query]);

  // «Padre>Hijo>texto»: lo de antes del último «>» es la ruta y lo último, lo que se busca.
  const parent = useMemo(() => (rows ? parentMap(rows) : null), [rows]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const segs = query.split('>');
  const title = segs[segs.length - 1].trim();
  const route = rows && parent && onCreatePath && segs.length > 1 ? resolvePath(rows, parent, segs.slice(0, -1).map((n) => n.trim()).filter(Boolean)) : null;

  let items: Item[];
  if (route && rows && parent) {
    const words = norm(title).split(/\s+/).filter(Boolean);
    const t = (r: NoteRow) => (r.updatedAt ? Date.parse(r.updatedAt) : 0);
    const inside = route.missing.length ? [] : rows.filter((r) => (parent.get(r.id) ?? null) === route.zoneId && r.id !== exclude && words.every((w) => norm(`${r.title ?? ''} ${r.bodyText ?? ''}`).includes(w)));
    inside.sort((a, b) => t(b) - t(a));
    items = inside.slice(0, 30).map((r) => ({ kind: 'note', hit: { id: r.id, title: r.title, bodyText: r.bodyText, kind: r.kind } }));
    const exact = inside.some((r) => norm(r.title ?? '') === norm(title));
    if ((title && !exact) || route.missing.length) items.push({ kind: 'path', text: routeText(route, title).replace(/^Enter crea /, 'Crear ') });
  } else {
    items = hits.filter((hit) => hit.id !== exclude).map((hit) => ({ kind: 'note', hit }));
    if (query.trim()) items.push({ kind: 'create', text: query.trim() });
  }

  const run = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'note') onPick(item.hit.id);
    else if (item.kind === 'path' && route) onCreatePath!(route.zoneId, route.missing, title);
    else if (item.kind === 'create') onCreate(item.text);
  };

  // Tab completa con lo señalado: su ruta entera, lista para seguir con «>».
  const complete = () => {
    const item = items[cursor];
    const row = item?.kind === 'note' ? byId.get(item.hit.id) : undefined;
    if (!row || !parent) return;
    setQuery(pathText(row, byId, parent, [...parent.values()].includes(row.id)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') run(items[cursor]);
    else if (e.key === 'Tab' && rows) {
      e.preventDefault();
      complete();
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
        <input
          id="note-search"
          className="field field-bare"
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="popover-divider" />
        {!query.trim() && hits.length > 0 && <div className="label">Recientes</div>}
        {route && route.found.length > 0 && !route.missing.length && <div className="label">Dentro de {route.found.map((z) => z.title || 'Nota sin título').join(' › ')}</div>}
        <ul className="list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.kind === 'note' ? item.hit.id : item.kind}
              role="option"
              aria-selected={i === cursor}
              className="list-item"
              style={{ '--i': i } as React.CSSProperties}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(item)}
            >
              {item.kind === 'note' ? (
                <div className="hit">
                  <span className="hit-title">{item.hit.title ?? 'Nota sin título'}</span>
                  {snippet(item.hit) && <span className="hit-snippet">{snippet(item.hit)}</span>}
                </div>
              ) : item.kind === 'path' ? (
                <>
                  <span className="list-icon">+</span>
                  {item.text}
                </>
              ) : (
                <>
                  <span className="list-icon">+</span>
                  Crear nota «{item.text}»
                </>
              )}
            </li>
          ))}
          {!query.trim() && !route && hits.length === 0 && <li className="list-item static">Aún no hay notas en este perfil.</li>}
        </ul>
      </div>
    </div>
  );
}
