import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ulid } from 'ulidx';
import { api, parseProps, type NoteInput, type NoteRow, type PropertyDef, type PropertyType, type PropValue } from '../api';
import { useContextMenu } from './Biblioteca';
import { okImageUrl } from './cover';
import { DatePicker } from './DatePicker';
import { hueOf } from './Inspector';
import { t } from '../i18n';

// Las propiedades de la nota bajo su título, como en Notion: una fila por
// propiedad (icono y nombre a la izquierda, valor a la derecha) y al final
// «Añadir propiedad». Solo salen las que tienen valor y las que se acaban de
// añadir; las demás esperan en ese menú.

type Props = {
  note: NoteRow;
  defs: PropertyDef[];
  profileId: string;
  onChange: (id: string, change: NoteInput) => void;
  onDefsChange: (update: (defs: PropertyDef[]) => PropertyDef[]) => void;
  onError: (err: unknown) => void;
};

const TYPES: { id: PropertyType; name: string }[] = [
  { id: 'text', name: 'Texto' },
  { id: 'tags', name: 'Etiquetas' },
  { id: 'select', name: 'Opciones' },
  { id: 'number', name: 'Número' },
  { id: 'date', name: 'Fecha' },
  { id: 'checkbox', name: 'Casilla' },
  { id: 'url', name: 'Enlace' },
  { id: 'image', name: 'Imagen' },
];

// La fecha de la nota no es una propiedad personalizada, pero se ve igual.
const DUE = 'due';

const filled = (v: PropValue | undefined) => !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length));

export function NoteProps({ note, defs, profileId, onChange, onDefsChange, onError }: Props) {
  const props = parseProps(note.props);
  // Las añadidas ahora mismo, aún vacías: se quedan a la vista para rellenarlas.
  const [fresh, setFresh] = useState<string[]>([]);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const showDue = !!note.dueAt || fresh.includes(DUE);
  const shown = defs.filter((d) => filled(props[d.id]) || fresh.includes(d.id));
  const hidden = defs.filter((d) => !shown.includes(d));

  const setProp = (def: PropertyDef, value: PropValue) => {
    const { [def.id]: _old, ...rest } = parseProps(note.props);
    onChange(note.id, { props: filled(value ?? undefined) ? { ...rest, [def.id]: value } : rest });
  };
  const addOption = (def: PropertyDef, option: string) => {
    if (def.options.some((o) => o.toLowerCase() === option.toLowerCase())) return;
    const options = [...def.options, option];
    onDefsChange((ds) => ds.map((d) => (d.id === def.id ? { ...d, options } : d)));
    api.updateProperty(def.id, { options }).catch(onError);
  };
  const reveal = (id: string) => {
    setFresh((f) => (f.includes(id) ? f : [...f, id]));
    setFocus(id);
  };
  const hide = (id: string) => {
    setFresh((f) => f.filter((x) => x !== id));
    if (id === DUE) onChange(note.id, { dueAt: null });
    else {
      const def = defs.find((d) => d.id === id);
      if (def) setProp(def, null);
    }
  };
  const create = (name: string, type: PropertyType) => {
    const def: PropertyDef = { id: ulid(), profileId, name, type, options: [], position: defs.length };
    onDefsChange((ds) => [...ds, def]);
    reveal(def.id);
    api.createProperty(profileId, { id: def.id, name, type }).catch((err) => {
      onDefsChange((ds) => ds.filter((d) => d.id !== def.id));
      onError(err);
    });
  };
  const rename = (def: PropertyDef, name: string) => {
    if (!name || name === def.name || defs.some((d) => d.id !== def.id && d.name.toLowerCase() === name.toLowerCase())) return;
    onDefsChange((ds) => ds.map((d) => (d.id === def.id ? { ...d, name } : d)));
    api.updateProperty(def.id, { name }).catch(onError);
  };
  const remove = (def: PropertyDef) => {
    onDefsChange((ds) => ds.filter((d) => d.id !== def.id));
    api.deleteProperty(def.id).catch(onError);
  };

  const at = (e: React.MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 4 };
  };
  const menuDef = menu && defs.find((d) => d.id === menu.id);

  return (
    <div className={`nprops${!showDue && !shown.length ? ' is-empty' : ''}`} role="list" aria-label={t('Propiedades')}>
      {showDue && (
        <Row id={DUE} icon="date" name={t('Fecha')} onName={(e) => setMenu({ ...at(e), id: DUE })}>
          <DatePicker className="nprop-input nprop-date" value={note.dueAt?.slice(0, 10) ?? null} placeholder={t('Vacío')} onChange={(dueAt) => onChange(note.id, { dueAt })} />
        </Row>
      )}
      {shown.map((def) => (
        <Row key={def.id} id={def.id} icon={def.type} name={def.name} onName={(e) => setMenu({ ...at(e), id: def.id })}>
          <Value def={def} value={props[def.id] ?? null} autoFocus={focus === def.id} onChange={(v) => setProp(def, v)} onAddOption={(o) => addOption(def, o)} />
        </Row>
      ))}
      <button className="nprop-add" onClick={(e) => setAdding(at(e))}>
        <span className="nprop-icon" aria-hidden="true">
          +
        </span>
        {t('Añadir propiedad')}
      </button>
      {adding &&
        createPortal(
          <AddMenu
            x={adding.x}
            y={adding.y}
            hidden={hidden}
            showDue={!showDue}
            onPick={(id) => {
              setAdding(null);
              reveal(id);
            }}
            onCreate={(name, type) => {
              setAdding(null);
              create(name, type);
            }}
            onClose={() => setAdding(null)}
          />,
          document.body,
        )}
      {menu &&
        createPortal(
          <NameMenu
            x={menu.x}
            y={menu.y}
            def={menuDef ?? null}
            taken={(name) => defs.some((d) => d.id !== menu.id && d.name.toLowerCase() === name.toLowerCase())}
            onRename={(name) => menuDef && rename(menuDef, name)}
            onHide={() => {
              setMenu(null);
              hide(menu.id);
            }}
            onDelete={() => {
              setMenu(null);
              if (menuDef) remove(menuDef);
            }}
            onClose={() => setMenu(null)}
          />,
          document.body,
        )}
    </div>
  );
}

function Row({ id, icon, name, onName, children }: { id: string; icon: PropertyType; name: string; onName: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <div className="nprop" role="listitem" data-prop={id}>
      <button className="nprop-k" onClick={onName} title={name}>
        <TypeIcon type={icon} />
        <span className="nprop-name">{name}</span>
      </button>
      <div className="nprop-v">{children}</div>
    </div>
  );
}

export function TypeIcon({ type }: { type: PropertyType }) {
  const p = { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  const paths: Record<PropertyType, ReactNode> = {
    text: <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />,
    tags: (
      <>
        <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
        <path d="M2.5 4h.5M2.5 8h.5M2.5 12h.5" strokeWidth="1.8" />
      </>
    ),
    select: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M5.8 7.2 8 9.4l2.2-2.2" />
      </>
    ),
    number: <path d="M6.2 2.5 4.8 13.5M11.2 2.5 9.8 13.5M2.8 5.8h10.6M2.6 10.2h10.6" />,
    date: (
      <>
        <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
        <path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" />
      </>
    ),
    checkbox: (
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
        <path d="m5.3 8.2 1.9 1.9 3.6-3.9" />
      </>
    ),
    url: <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7" />,
    image: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="2" />
        <circle cx="6" cy="6.5" r="1.1" />
        <path d="m2.8 11.6 3.4-3.2 2.6 2.4 1.7-1.5 2.8 2.5" />
      </>
    ),
  };
  return (
    <span className="nprop-icon">
      <svg {...p}>{paths[type]}</svg>
    </span>
  );
}

// Campo que guarda al salir o con Intro, no con cada tecla.
function Field({ value, type, autoFocus, onChange }: { value: string; type: 'text' | 'number' | 'url'; autoFocus?: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="nprop-input"
      type={type === 'number' ? 'number' : 'text'}
      inputMode={type === 'url' ? 'url' : undefined}
      value={draft}
      autoFocus={autoFocus}
      placeholder={t('Vacío')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function Value({ def, value, autoFocus, onChange, onAddOption }: { def: PropertyDef; value: PropValue; autoFocus: boolean; onChange: (v: PropValue) => void; onAddOption: (o: string) => void }) {
  switch (def.type) {
    case 'checkbox':
      return (
        <button className={`nprop-check${value === true ? ' is-on' : ''}`} role="checkbox" aria-checked={value === true} aria-label={def.name} onClick={() => onChange(value !== true)} autoFocus={autoFocus}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.5 8.2 3 3 6-6.4" />
          </svg>
        </button>
      );
    case 'date':
      return <DatePicker className="nprop-input nprop-date" value={typeof value === 'string' ? value.slice(0, 10) : null} placeholder={t('Vacío')} onChange={onChange} />;
    case 'select':
    case 'tags':
      return <Options def={def} value={value} autoOpen={autoFocus} onChange={onChange} onAddOption={onAddOption} />;
    case 'image':
      return <ImageValue value={typeof value === 'string' ? value : ''} autoFocus={autoFocus} onChange={onChange} />;
    case 'number':
      return <Field type="number" autoFocus={autoFocus} value={value === null ? '' : String(value)} onChange={(v) => onChange(v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))} />;
    default:
      return (
        <span className="nprop-line">
          <Field type={def.type === 'url' ? 'url' : 'text'} autoFocus={autoFocus} value={value === null ? '' : String(value)} onChange={(v) => onChange(v.trim() || null)} />
          {def.type === 'url' && typeof value === 'string' && /^https?:\/\//i.test(value) && (
            <a className="nprop-open" href={value} target="_blank" rel="noreferrer" aria-label={t('Abrir enlace')} title={t('Abrir enlace')}>
              ↗
            </a>
          )}
        </span>
      );
  }
}

// Una imagen: se pega su enlace o se sube un archivo. La miniatura, si vale.
function ImageValue({ value, autoFocus, onChange }: { value: string; autoFocus: boolean; onChange: (v: PropValue) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pick = (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setFailed(false);
    api
      .uploadMedia(f)
      .then(({ url, kind }) => (kind === 'image' ? onChange(url) : setFailed(true)))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <span className="nprop-line">
      {okImageUrl(value) && <span className="nprop-thumb" style={{ backgroundImage: `url("${value.replace(/"/g, '%22')}")` }} aria-hidden="true" />}
      <Field type="url" autoFocus={autoFocus} value={value} onChange={(v) => onChange(v.trim() || null)} />
      <button className="nprop-open" type="button" disabled={busy} onClick={() => file.current?.click()} aria-label={t('Subir imagen')} title={failed ? t('No se pudo subir la imagen') : t('Subir imagen')}>
        {busy ? '…' : failed ? '!' : '↑'}
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </span>
  );
}

const pill = (o: string) => ({ '--chip': hueOf(o) }) as CSSProperties;

// Opciones y etiquetas: sus píldoras, y al pulsar, un menú para elegir o crear.
function Options({ def, value, autoOpen, onChange, onAddOption }: { def: PropertyDef; value: PropValue; autoOpen: boolean; onChange: (v: PropValue) => void; onAddOption: (o: string) => void }) {
  const many = def.type === 'tags';
  const on = many ? (Array.isArray(value) ? value : []) : typeof value === 'string' && value ? [value] : [];
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    const r = box.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left, y: r.bottom + 4 });
  };
  useEffect(() => {
    if (autoOpen) openMenu();
  }, [autoOpen]);
  const has = (x: string) => on.some((o) => o.toLowerCase() === x.toLowerCase());
  const toggle = (raw: string) => {
    const o = raw.replace(/^#/, '').trim();
    if (!o) return;
    const known = def.options.find((x) => x.toLowerCase() === o.toLowerCase());
    if (!known) onAddOption(o);
    const name = known ?? o;
    if (many) onChange(has(name) ? on.filter((x) => x.toLowerCase() !== name.toLowerCase()) : [...on, name]);
    else {
      onChange(has(name) ? null : name);
      setOpen(null);
    }
  };
  return (
    <>
      <button ref={box} className="nprop-pills" onClick={openMenu} aria-haspopup="menu">
        {on.length ? (
          on.map((o) => (
            <span key={o} className="nprop-pill" style={pill(o)}>
              {o}
            </span>
          ))
        ) : (
          <span className="nprop-empty">{t('Vacío')}</span>
        )}
      </button>
      {open &&
        createPortal(<OptionsMenu x={open.x} y={open.y} options={def.options} on={on} many={many} onToggle={toggle} onClose={() => setOpen(null)} />, document.body)}
    </>
  );
}

function OptionsMenu({ x, y, options, on, many, onToggle, onClose }: { x: number; y: number; options: string[]; on: string[]; many: boolean; onToggle: (o: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => input.current?.focus(), []);
  const query = q.trim().replace(/^#/, '');
  const list = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));
  const exact = options.some((o) => o.toLowerCase() === query.toLowerCase());
  return (
    <div className="bib-menu nprop-menu" ref={ref} role="menu" style={{ left: spot.x, top: spot.y }}>
      <div className="nprop-menu-pills">
        {on.map((o) => (
          <span key={o} className="nprop-pill" style={pill(o)}>
            {o}
            <button onClick={() => onToggle(o)} aria-label={t('Quitar')}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={on.length ? '' : many ? t('Busca o crea una etiqueta…') : t('Busca o crea una opción…')}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || (many && e.key === ',')) && query) {
              e.preventDefault();
              onToggle(list.length === 1 && !exact ? list[0] : query);
              setQ('');
            } else if (e.key === 'Backspace' && !q && on.length) onToggle(on[on.length - 1]);
          }}
        />
      </div>
      <div className="bib-menu-head">{many ? t('Elige una o varias') : t('Elige una opción')}</div>
      {list.map((o) => (
        <button key={o} className={`bib-menu-it${on.includes(o) ? ' is-on' : ''}`} onClick={() => onToggle(o)}>
          <span className="nprop-pill" style={pill(o)}>
            {o}
          </span>
          {on.includes(o) && <span className="bib-menu-k">✓</span>}
        </button>
      ))}
      {query && !exact && (
        <button
          className="bib-menu-it"
          onClick={() => {
            onToggle(query);
            setQ('');
          }}
        >
          {t('Crear')}&nbsp;
          <span className="nprop-pill" style={pill(query)}>
            {query}
          </span>
        </button>
      )}
    </div>
  );
}

function AddMenu({ x, y, hidden, showDue, onPick, onCreate, onClose }: { x: number; y: number; hidden: PropertyDef[]; showDue: boolean; onPick: (id: string) => void; onCreate: (name: string, type: PropertyType) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => input.current?.focus(), []);
  const name = q.trim();
  const low = name.toLowerCase();
  const due = showDue && t('Fecha').toLowerCase().includes(low);
  const list = hidden.filter((d) => d.name.toLowerCase().includes(low));
  const exact = hidden.find((d) => d.name.toLowerCase() === low) ?? (showDue && t('Fecha').toLowerCase() === low ? DUE : null);
  return (
    <div className="bib-menu nprop-menu" ref={ref} role="menu" style={{ left: spot.x, top: spot.y }}>
      <input
        ref={input}
        className="nprop-menu-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('Busca o escribe un nombre…')}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !name) return;
          e.preventDefault();
          if (exact) onPick(typeof exact === 'string' ? exact : exact.id);
          else if (list.length + Number(due) === 1) onPick(due ? DUE : list[0].id);
          else onCreate(name, 'text');
        }}
      />
      {(due || list.length > 0) && <div className="bib-menu-head">{t('Propiedades')}</div>}
      {due && (
        <button className="bib-menu-it nprop-menu-it" onClick={() => onPick(DUE)}>
          <TypeIcon type="date" />
          {t('Fecha')}
        </button>
      )}
      {list.map((d) => (
        <button key={d.id} className="bib-menu-it nprop-menu-it" onClick={() => onPick(d.id)}>
          <TypeIcon type={d.type} />
          {d.name}
        </button>
      ))}
      {name && !exact && (
        <>
          <div className="bib-menu-sep" />
          <div className="bib-menu-head">{t('Nueva propiedad «{name}»', { name })}</div>
          {TYPES.map((ty) => (
            <button key={ty.id} className="bib-menu-it nprop-menu-it" onClick={() => onCreate(name, ty.id)}>
              <TypeIcon type={ty.id} />
              {t(ty.name)}
            </button>
          ))}
        </>
      )}
      {!name && !due && !list.length && <div className="bib-menu-head">{t('Escribe un nombre para crear una propiedad')}</div>}
    </div>
  );
}

function NameMenu({ x, y, def, taken, onRename, onHide, onDelete, onClose }: { x: number; y: number; def: PropertyDef | null; taken: (name: string) => boolean; onRename: (name: string) => void; onHide: () => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const [name, setName] = useState(def?.name ?? '');
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const clash = !!name.trim() && taken(name.trim());
  const save = () => {
    if (def && name.trim() && !clash) onRename(name.trim());
  };
  // También al cerrar el menú pulsando fuera (entonces el campo no llega a perder el foco).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), []);
  return (
    <div className="bib-menu nprop-menu" ref={ref} role="menu" style={{ left: spot.x, top: spot.y }}>
      {def && (
        <>
          <input
            ref={input}
            className="nprop-menu-input"
            value={name}
            aria-label={t('Nombre de la propiedad')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onClose();
            }}
          />
          {clash && <div className="bib-menu-head nprop-warn">{t('Ya existe')}</div>}
          <div className="bib-menu-head">{t(TYPES.find((ty) => ty.id === def.type)?.name ?? 'Texto')}</div>
          <div className="bib-menu-sep" />
        </>
      )}
      <button className="bib-menu-it" onClick={onHide}>
        {t('Quitar de esta nota')}
      </button>
      {def && (
        <button className="bib-menu-it is-danger" onClick={() => (confirm ? onDelete() : setConfirm(true))} title={t('Borrar esta propiedad de todas las notas')}>
          {confirm ? t('¿Borrarla de todas las notas?') : t('Borrar propiedad')}
        </button>
      )}
    </div>
  );
}
