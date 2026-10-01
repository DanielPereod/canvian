import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { FONTS, KINDS, SAME_AS_UI, THEME } from './typography';
import { getLang, t } from './i18n';

// Selector de letra propio, en vez del <select> nativo: una lista filtrable
// y agrupada (Sans, Serif, Monoespaciadas), con cada nombre en su propia letra.

type Option = { id: string; name: string; stack?: string };

type Props = {
  value: string;
  sameAsUi?: boolean;
  label: string;
  onPick: (id: string) => void;
};

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const all = (): Option[] => [{ id: THEME, name: t('Del tema') }, { id: SAME_AS_UI, name: t('La de la interfaz') }, ...FONTS.map((f) => ({ ...f, name: t(f.name) }))];

export function FontPicker({ value, sameAsUi, label, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const groups = useMemo(() => {
    const q = norm(query.trim());
    const top: Option[] = [{ id: THEME, name: t('Del tema') }, ...(sameAsUi ? [{ id: SAME_AS_UI, name: t('La de la interfaz') }] : [])].filter(
      (o) => !q || norm(o.name).includes(q),
    );
    const rest = KINDS.map((k) => ({
      name: t(k.name),
      items: FONTS.filter((f) => f.kind === k.id && (!q || norm(t(f.name)).includes(q))).map((f) => ({ ...f, name: t(f.name) })) as Option[],
    }));
    return [{ name: '', items: top }, ...rest].filter((g) => g.items.length);
  }, [query, sameAsUi, getLang()]);

  const flat = groups.flatMap((g) => g.items);
  const at = Math.min(cursor, Math.max(0, flat.length - 1));
  const current = all().find((o) => o.id === value);

  const pick = (id: string) => {
    onPick(id);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(Math.min(at + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === 'Enter' && flat[at]) pick(flat[at].id);
  };

  let i = 0;
  return (
    <>
      <button
        type="button"
        className="set-select"
        aria-label={label}
        onClick={() => {
          setQuery('');
          setCursor(Math.max(0, flat.findIndex((o) => o.id === value)));
          setOpen(true);
        }}
      >
        <span style={current?.stack ? { fontFamily: current.stack } : undefined}>{current?.name ?? value}</span>
      </button>
      {open && (
        <div className="overlay" onMouseDown={() => setOpen(false)}>
          <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
            <input
              className="field field-bare"
              autoFocus
              placeholder={t('Buscar en {what}…', { what: label.toLowerCase() })}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={onKeyDown}
            />
            <div className="popover-divider" />
            <ul className="list" role="listbox" aria-label={label}>
              {!flat.length && <li className="list-item static">{t('Ninguna letra se llama así.')}</li>}
              {groups.map((g) => (
                <ListGroup key={g.name || '_top'} name={g.name}>
                  {g.items.map((o) => {
                    const idx = i++;
                    return (
                      <li
                        key={o.id}
                        role="option"
                        aria-selected={idx === at}
                        className={`list-item${o.id === value ? ' is-current' : ''}`}
                        style={{ '--i': idx } as CSSProperties}
                        onMouseEnter={() => setCursor(idx)}
                        onClick={() => pick(o.id)}
                      >
                        <span style={o.stack ? { fontFamily: o.stack } : undefined}>{o.name}</span>
                        {o.id === value && <span className="meta list-note">{t('elegida')}</span>}
                      </li>
                    );
                  })}
                </ListGroup>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

// Fragmento para no romper el <ul>: el título del grupo, si tiene uno, y sus filas.
function ListGroup({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      {name && (
        <li className="list-group" aria-hidden="true">
          {name}
        </li>
      )}
      {children}
    </>
  );
}
