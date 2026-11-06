import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type NoteRow, type SearchHit } from '../api';
import { parentMap, pathText, resolvePath, routeText } from './sections';
import { t } from '../i18n';
import { withoutMarks } from './tasks';

type Props = {
  profileId: string;
  // `found`: lo buscado, si sale en el texto de la nota y no en su título.
  onPick: (id: string, found?: string) => void;
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

// El trozo del texto donde está lo buscado (sin la sintaxis de las tareas),
// con lo que coincide resaltado, como en Obsidian o Raycast.
function snippet(hit: SearchHit, words: string[]): ReactNode {
  const lines = (hit.bodyText ?? '').split('\n').map(withoutMarks).filter(Boolean);
  if (hit.title && lines[0] === hit.title) lines.shift();
  const body = lines.join(' · ');
  if (!body) return null;
  const flat = norm(body);
  // La primera palabra buscada que sale en el texto (norm no cambia la longitud: quita tildes, no letras).
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = flat.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) [at, len] = [i, w.length];
  }
  if (at < 0 || flat.length !== body.length) return body.slice(0, 110);
  const from = Math.max(0, at - 36);
  return (
    <>
      {from > 0 && '…'}
      {body.slice(from, at)}
      <mark>{body.slice(at, at + len)}</mark>
      {body.slice(at + len, at + len + 90)}
    </>
  );
}

export function CommandPalette({ profileId, onPick, onCreate, onClose, placeholder = t('Buscar notas o crear una · > para rutas'), exclude, rows, onCreatePath }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  // La búsqueda del servidor no sabe de archivadas: se queda solo con las que se ven.
  const visible = useRef<Set<string> | null>(null);
  visible.current = rows ? new Set(rows.map((r) => r.id)) : null;
  // Dónde está cada nota («Viaje a Japón › Qué ver»), para distinguir las que se llaman igual.
  const where = useMemo(() => {
    if (!rows) return null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = parentMap(rows);
    return (id: string) => {
      const names: string[] = [];
      for (let z = byId.get(parent.get(id) ?? ''); z; z = byId.get(parent.get(z.id) ?? '')) names.unshift(z.title || t('Nota sin título'));
      return names.join(' › ');
    };
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
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
      clearTimeout(timer);
    };
  }, [profileId, query]);

  // «Padre>Hijo>texto»: lo de antes del último «>» es la ruta y lo último, lo que se busca.
  const parent = useMemo(() => (rows ? parentMap(rows) : null), [rows]);
  const byId = useMemo(() => new Map((rows ?? []).map((r) => [r.id, r])), [rows]);
  const segs = query.split('>');
  const title = segs[segs.length - 1].trim();
  const route = rows && parent && onCreatePath && segs.length > 1 ? resolvePath(rows, parent, segs.slice(0, -1).map((n) => n.trim()).filter(Boolean)) : null;

  const words = norm(title).split(/\s+/).filter(Boolean);
  let items: Item[];
  if (route && rows && parent) {
    const time = (r: NoteRow) => (r.updatedAt ? Date.parse(r.updatedAt) : 0);
    const inside = route.missing.length ? [] : rows.filter((r) => (parent.get(r.id) ?? null) === route.zoneId && r.id !== exclude && words.every((w) => norm(`${r.title ?? ''} ${r.bodyText ?? ''}`).includes(w)));
    inside.sort((a, b) => time(b) - time(a));
    items = inside.slice(0, 30).map((r) => ({ kind: 'note', hit: { id: r.id, title: r.title, bodyText: r.bodyText, kind: r.kind } }));
    const exact = inside.some((r) => norm(r.title ?? '') === norm(title));
    if ((title && !exact) || route.missing.length) items.push({ kind: 'path', text: routeText(route, title, true) });
  } else {
    items = hits.filter((hit) => hit.id !== exclude).map((hit) => ({ kind: 'note', hit }));
    if (query.trim()) items.push({ kind: 'create', text: query.trim() });
  }

  const run = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'note') {
      const inTitle = words.every((w) => norm(item.hit.title ?? '').includes(w));
      onPick(item.hit.id, words.length && !inTitle ? title : undefined);
    }
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
        {!query.trim() && hits.length > 0 && <div className="label">{t('Recientes')}</div>}
        {route && route.found.length > 0 && !route.missing.length && <div className="label">{t('Dentro de {where}', { where: route.found.map((z) => z.title || t('Nota sin título')).join(' › ') })}</div>}
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
                  <span className="hit-title">
                    {item.hit.title ?? t('Nota sin título')}
                    {where?.(item.hit.id) && <span className="hit-path">{where(item.hit.id)}</span>}
                  </span>
                  {(() => {
                    const body = snippet(item.hit, words);
                    return body && <span className="hit-snippet">{body}</span>;
                  })()}
                </div>
              ) : item.kind === 'path' ? (
                <>
                  <span className="list-icon">+</span>
                  {item.text}
                </>
              ) : (
                <>
                  <span className="list-icon">+</span>
                  {t('Crear nota «{name}»', { name: item.text })}
                </>
              )}
            </li>
          ))}
          {!query.trim() && !route && hits.length === 0 && <li className="list-item static">{t('Aún no hay notas en este perfil.')}</li>}
        </ul>
      </div>
    </div>
  );
}
