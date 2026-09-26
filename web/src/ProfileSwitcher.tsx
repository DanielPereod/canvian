import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Profile } from './api';

type Item =
  | { kind: 'profile'; profile: Profile }
  | { kind: 'create'; name: string }
  | { kind: 'signout' };

type Props = {
  profiles: Profile[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onSignOut: () => void;
  onClose: () => void;
};

export function ProfileSwitcher({ profiles, activeId, onSelect, onCreate, onSignOut, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = profiles
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((profile) => ({ kind: 'profile', profile }) as Item);
    const exact = profiles.some((p) => p.name.toLowerCase() === q);
    if (q && !exact) matches.push({ kind: 'create', name: query.trim() });
    if (!q) matches.push({ kind: 'signout' });
    return matches;
  }, [profiles, query]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'profile') onSelect(item.profile.id);
    else if (item.kind === 'create') void onCreate(item.name);
    else onSignOut();
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
      <div className="glass palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          id="profile-search"
          autoFocus
          placeholder="Cambiar de perfil o crear uno"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul role="listbox">
          {items.map((item, i) => (
            <li
              key={item.kind === 'profile' ? item.profile.id : item.kind}
              role="option"
              aria-selected={i === cursor}
              className={i === cursor ? 'selected' : undefined}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(item)}
            >
              {item.kind === 'profile' && (
                <>
                  <span className="dot" style={{ background: item.profile.color ?? 'var(--accent)' }} />
                  {item.profile.name}
                  {item.profile.id === activeId && <span className="muted tail">actual</span>}
                </>
              )}
              {item.kind === 'create' && (
                <>
                  <span className="dot ghost">+</span>
                  Crear perfil «{item.name}»
                </>
              )}
              {item.kind === 'signout' && <span className="muted">Cerrar sesión</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
