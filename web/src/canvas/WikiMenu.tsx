import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { NoteRow } from '../api';
import { splitWiki, type WikiQuery } from './obsidian';

// La lista que sale al escribir «[[» en una nota: las notas del perfil que
// casan con lo escrito, y crear una nueva si no hay ninguna con ese nombre.

export type WikiItem = { kind: 'note'; row: NoteRow } | { kind: 'create'; title: string };

const MAX = 8;
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

// El texto normalizado de cada nota, mientras la nota no cambie.
const cache = new WeakMap<NoteRow, { title: string; body: string }>();
function textOf(r: NoteRow) {
  let t = cache.get(r);
  if (!t) {
    t = { title: norm(r.title ?? ''), body: norm((r.bodyText ?? '').slice(0, 2000)) };
    cache.set(r, t);
  }
  return t;
}

export function wikiItems(rows: NoteRow[], query: string, exclude: string): WikiItem[] {
  const q = norm(splitWiki(query).note);
  const words = q.split(/\s+/).filter(Boolean);
  const time = (r: NoteRow) => (r.updatedAt ? Date.parse(r.updatedAt) : 0);
  const hits: { row: NoteRow; score: number }[] = [];
  for (const r of rows) {
    if (r.id === exclude) continue;
    const { title, body } = textOf(r);
    // Primero el nombre exacto, luego lo que empieza así, lo que lo contiene
    // en el nombre y, al final, lo que lo dice en el texto.
    const score = !words.length ? 3 : title === q ? 0 : title.startsWith(q) ? 1 : words.every((w) => title.includes(w)) ? 2 : words.every((w) => body.includes(w)) ? 4 : -1;
    if (score >= 0) hits.push({ row: r, score });
  }
  hits.sort((a, b) => a.score - b.score || time(b.row) - time(a.row));
  const items: WikiItem[] = hits.slice(0, MAX).map((h) => ({ kind: 'note', row: h.row }));
  const name = splitWiki(query).note;
  if (name && !hits.some((h) => h.score === 0)) items.push({ kind: 'create', title: name });
  return items;
}

type Props = {
  query: WikiQuery;
  rows: NoteRow[];
  exclude: string;
  onPick: (item: WikiItem) => void;
  // La hoja le pasa aquí las teclas del editor mientras la lista está abierta.
  keys: { current: (e: KeyboardEvent) => boolean };
};

export function WikiMenu({ query, rows, exclude, onPick, keys }: Props) {
  const items = useMemo(() => wikiItems(rows, query.query, exclude), [rows, query.query, exclude]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [query.query]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  keys.current = (e) => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((c) => (c + step + items.length) % items.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      onPick(items[Math.min(cursor, items.length - 1)]);
      return true;
    }
    return false;
  };

  // Debajo del «[[», o encima si no cabe.
  const below = query.bottom + 320 < window.innerHeight;
  const style: CSSProperties = {
    left: Math.max(8, Math.min(query.left, window.innerWidth - 348)),
    ...(below ? { top: query.bottom + 6 } : { bottom: window.innerHeight - query.top + 6 }),
  };

  // En el body: dentro de la hoja, su animación desplazaría la posición fija.
  return createPortal(
    <div className="surface-3 wiki-suggest" style={style} role="listbox" aria-label="Enlazar con una nota" onMouseDown={(e) => e.preventDefault()}>
      {items.length === 0 ? (
        <div className="list-item static">Escribe el nombre de una nota</div>
      ) : (
        <ul className="list">
          {items.map((item, i) => (
            <li
              key={item.kind === 'note' ? item.row.id : 'create'}
              role="option"
              aria-selected={i === cursor}
              className="list-item"
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(item)}
            >
              {item.kind === 'note' ? (
                <div className="hit">
                  <span className="hit-title">{item.row.title || 'Nota sin título'}</span>
                  {item.row.zoneId && byId.get(item.row.zoneId) && <span className="hit-snippet">en {byId.get(item.row.zoneId)!.title || 'Nota sin título'}</span>}
                </div>
              ) : (
                <>
                  <span className="list-icon">+</span>
                  Crear nota «{item.title}»
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
