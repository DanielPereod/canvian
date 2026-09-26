import { useEffect, useState, type KeyboardEvent } from 'react';
import { api, type SearchHit } from '../api';

type Props = {
  profileId: string;
  onPick: (id: string) => void;
  onCreate: (text: string) => void;
  onClose: () => void;
};

type Item = { kind: 'note'; hit: SearchHit } | { kind: 'create'; text: string };

function snippet(hit: SearchHit): string {
  const body = (hit.bodyText ?? '').replace(/\s+/g, ' ').trim();
  const rest = hit.title && body.startsWith(hit.title) ? body.slice(hit.title.length).trim() : body;
  return rest.slice(0, 90);
}

export function CommandPalette({ profileId, onPick, onCreate, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(profileId, query).then(
        (rows) => {
          if (cancelled) return;
          setHits(rows);
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

  const items: Item[] = hits.map((hit) => ({ kind: 'note', hit }));
  if (query.trim()) items.push({ kind: 'create', text: query.trim() });

  const run = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'note') onPick(item.hit.id);
    else onCreate(item.text);
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
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
        <input
          id="note-search"
          className="field field-bare"
          autoFocus
          placeholder="Buscar notas o crear una"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="popover-divider" />
        {!query.trim() && hits.length > 0 && <div className="label">Recientes</div>}
        <ul className="list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.kind === 'note' ? item.hit.id : 'create'}
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
              ) : (
                <>
                  <span className="list-icon">+</span>
                  Crear nota «{item.text}»
                </>
              )}
            </li>
          ))}
          {!query.trim() && hits.length === 0 && <li className="list-item static">Aún no hay notas en este perfil.</li>}
        </ul>
      </div>
    </div>
  );
}
