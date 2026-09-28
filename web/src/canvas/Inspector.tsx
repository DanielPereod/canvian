import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ulid } from 'ulidx';
import {
  api,
  parseProps,
  type NoteInput,
  type NoteRow,
  type PropertyDef,
  type PropertyType,
  type PropValue,
  type TaskStatus,
} from '../api';
import { kindChange } from './board/board';

export const PRIORITIES = ['Sin prioridad', 'Baja', 'Media', 'Alta'] as const;
const STATUSES: { id: TaskStatus; name: string }[] = [
  { id: 'todo', name: 'Pendiente' },
  { id: 'doing', name: 'En curso' },
  { id: 'blocked', name: 'Bloqueada' },
  { id: 'done', name: 'Hecha' },
];
const TYPES: { id: PropertyType; name: string }[] = [
  { id: 'text', name: 'Texto' },
  { id: 'select', name: 'Opciones' },
  { id: 'tags', name: 'Etiquetas' },
  { id: 'number', name: 'Número' },
  { id: 'date', name: 'Fecha' },
  { id: 'checkbox', name: 'Casilla' },
  { id: 'url', name: 'Enlace' },
];

type Props = {
  note: NoteRow | null;
  defs: PropertyDef[];
  profileId: string;
  onChange: (id: string, change: NoteInput) => void;
  onDefsChange: (update: (defs: PropertyDef[]) => PropertyDef[]) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
};

// Panel lateral con las propiedades de la nota seleccionada (tecla P).
export function Inspector({ note, defs, profileId, onChange, onDefsChange, onError, onClose }: Props) {
  const [closing, setClosing] = useState(false);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 180);
  };

  const setProp = (def: PropertyDef, value: PropValue) => {
    if (!note) return;
    const { [def.id]: _old, ...rest } = parseProps(note.props);
    const empty = value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
    onChange(note.id, { props: empty ? rest : { ...rest, [def.id]: value } });
  };

  const addOption = (def: PropertyDef, option: string) => {
    if (def.options.some((o) => o.toLowerCase() === option.toLowerCase())) return;
    const options = [...def.options, option];
    onDefsChange((ds) => ds.map((d) => (d.id === def.id ? { ...d, options } : d)));
    api.updateProperty(def.id, { options }).catch(onError);
  };

  const removeDef = (def: PropertyDef) => {
    onDefsChange((ds) => ds.filter((d) => d.id !== def.id));
    api.deleteProperty(def.id).catch(onError);
  };

  const props = parseProps(note?.props);
  const task = note?.kind === 'task';

  return (
    <aside
      className={`surface-3 inspector${closing ? ' is-closing' : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) close();
      }}
      aria-label="Propiedades"
    >
      <header className="insp-head">
        <span className="label">Propiedades</span>
        <button className="insp-close" onClick={close} aria-label="Cerrar">
          ×
        </button>
      </header>

      {!note ? (
        <p className="insp-empty">
          Selecciona una <em>nota</em>
        </p>
      ) : (
        <div className="insp-body" key={note.id}>
          <p className="insp-title">{note.title || 'Nota sin título'}</p>

          <Row label="Tipo" i={0}>
            <Segmented
              value={note.kind === 'canvas' ? 'canvas' : task ? 'task' : 'text'}
              options={[
                { id: 'text', name: 'Nota' },
                { id: 'task', name: 'Tarea' },
                { id: 'canvas', name: 'Canvas' },
              ]}
              onChange={(v) => onChange(note.id, kindChange(note, v as 'text' | 'task' | 'canvas'))}
            />
          </Row>

          {task && (
            <Row label="Estado" i={1} wide>
              <div className="insp-status">
                <Segmented
                  value={note.status ?? 'todo'}
                  options={STATUSES}
                  onChange={(status) =>
                    onChange(note.id, { status, doneAt: status === 'done' ? new Date().toISOString() : null })
                  }
                />
              </div>
            </Row>
          )}

          <Row label="Prioridad" i={2}>
            <Segmented
              value={String(note.priority ?? 0)}
              options={PRIORITIES.map((name, i) => ({ id: String(i), name: i === 0 ? '—' : name, className: `prio-${i}` }))}
              onChange={(v) => onChange(note.id, { priority: Number(v) || null })}
            />
          </Row>

          <Row label="Fecha" i={3}>
            <DateInput value={note.dueAt} onChange={(dueAt) => onChange(note.id, { dueAt })} />
          </Row>

          {defs.map((def, i) => (
            <Row key={def.id} label={def.name} i={4 + i} onRemove={() => removeDef(def)}>
              <PropControl def={def} value={props[def.id] ?? null} onChange={(v) => setProp(def, v)} onAddOption={(o) => addOption(def, o)} />
            </Row>
          ))}

          <NewProperty
            existing={defs}
            onCreate={(name, type) => {
              const def: PropertyDef = { id: ulid(), profileId, name, type, options: [], position: defs.length };
              onDefsChange((ds) => [...ds, def]);
              api.createProperty(profileId, { id: def.id, name, type }).catch((err) => {
                onDefsChange((ds) => ds.filter((d) => d.id !== def.id));
                onError(err);
              });
            }}
          />
        </div>
      )}
    </aside>
  );
}

function Row({ label, i, children, onRemove, wide }: { label: string; i: number; children: ReactNode; onRemove?: () => void; wide?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 2500);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <div className={`insp-row${wide ? ' insp-row-wide' : ''}`} style={{ '--i': i } as CSSProperties}>
      <span className="insp-label">
        <span className="insp-label-text">{label}</span>
        {onRemove && (
          <button
            className={`insp-remove${confirm ? ' confirm' : ''}`}
            onClick={() => (confirm ? onRemove() : setConfirm(true))}
            title="Borrar esta propiedad de todas las notas"
          >
            {confirm ? '¿Borrar?' : '×'}
          </button>
        )}
      </span>
      <div className="insp-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; name: string; className?: string }[];
  onChange: (v: T) => void;
}) {
  const index = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div className="segmented" style={{ '--n': options.length, '--at': index } as CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.id}
          className={`${o.className ?? ''}${o.id === value ? ' on' : ''}`}
          aria-pressed={o.id === value}
          onClick={() => o.id !== value && onChange(o.id)}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

function DateInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <span className="insp-date">
      <input
        type="date"
        className="insp-input"
        value={value?.slice(0, 10) ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      />
      {value && (
        <button className="insp-clear" onClick={() => onChange(null)} aria-label="Quitar fecha">
          ×
        </button>
      )}
    </span>
  );
}

// Campo de texto que guarda al salir o con Enter, no en cada tecla.
function TextInput({ value, type, onChange }: { value: string; type: 'text' | 'number' | 'url'; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="insp-input"
      type={type === 'number' ? 'number' : type === 'url' ? 'url' : 'text'}
      value={draft}
      placeholder={type === 'url' ? 'https://…' : 'Vacío'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function PropControl({
  def,
  value,
  onChange,
  onAddOption,
}: {
  def: PropertyDef;
  value: PropValue;
  onChange: (v: PropValue) => void;
  onAddOption: (o: string) => void;
}) {
  const [adding, setAdding] = useState('');
  switch (def.type) {
    case 'checkbox':
      return (
        <button className="insp-switch" role="switch" aria-checked={value === true} onClick={() => onChange(value !== true)}>
          <span className="switch" aria-hidden="true" />
        </button>
      );
    case 'date':
      return <DateInput value={typeof value === 'string' ? value : null} onChange={onChange} />;
    case 'select':
      return (
        <div className="insp-options">
          {def.options.map((o) => (
            <button
              key={o}
              className={`chip${value === o ? ' on' : ''}`}
              style={{ '--chip': hueOf(o) } as CSSProperties}
              onClick={() => onChange(value === o ? null : o)}
            >
              {o}
            </button>
          ))}
          <input
            className="insp-input insp-add-option"
            value={adding}
            placeholder={def.options.length ? '+ opción' : 'Escribe una opción…'}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              const o = adding.trim();
              if (e.key === 'Enter' && o) {
                onAddOption(o);
                onChange(o);
                setAdding('');
              }
            }}
          />
        </div>
      );
    case 'tags': {
      // Varias a la vez: las puestas con ×, las conocidas para añadir con un clic.
      const on = Array.isArray(value) ? value : [];
      const has = (t: string) => on.some((o) => o.toLowerCase() === t.toLowerCase());
      const add = (t: string) => {
        const tag = t.replace(/^#/, '').trim();
        if (!tag || has(tag)) return;
        if (!def.options.some((o) => o.toLowerCase() === tag.toLowerCase())) onAddOption(tag);
        onChange([...on, tag]);
      };
      return (
        <div className="insp-options">
          {on.map((t) => (
            <button key={t} className="chip on" style={{ '--chip': hueOf(t) } as CSSProperties} onClick={() => onChange(on.filter((o) => o !== t))} title="Quitar">
              #{t} ×
            </button>
          ))}
          {def.options.filter((o) => !has(o)).map((o) => (
            <button key={o} className="chip" style={{ '--chip': hueOf(o) } as CSSProperties} onClick={() => add(o)}>
              #{o}
            </button>
          ))}
          <input
            className="insp-input insp-add-option"
            value={adding}
            placeholder={on.length || def.options.length ? '+ etiqueta' : 'Escribe una etiqueta…'}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ',') && adding.trim()) {
                e.preventDefault();
                add(adding);
                setAdding('');
              }
            }}
          />
        </div>
      );
    }
    case 'number':
      return (
        <TextInput
          type="number"
          value={value === null ? '' : String(value)}
          onChange={(v) => onChange(v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))}
        />
      );
    default:
      return (
        <span className="insp-date">
          <TextInput type={def.type === 'url' ? 'url' : 'text'} value={value === null ? '' : String(value)} onChange={(v) => onChange(v.trim() || null)} />
          {def.type === 'url' && typeof value === 'string' && value && (
            <a className="insp-clear" href={value} target="_blank" rel="noreferrer" aria-label="Abrir enlace">
              ↗
            </a>
          )}
        </span>
      );
  }
}

function NewProperty({ existing, onCreate }: { existing: PropertyDef[]; onCreate: (name: string, type: PropertyType) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('text');
  const clash = existing.some((d) => d.name.toLowerCase() === name.trim().toLowerCase());

  const submit = () => {
    if (!name.trim() || clash) return;
    onCreate(name.trim(), type);
    setName('');
    setType('text');
    setOpen(false);
  };

  if (!open)
    return (
      <button className="insp-new" onClick={() => setOpen(true)}>
        + Nueva propiedad
      </button>
    );

  return (
    <div className="insp-new-form">
      <input
        className="insp-input"
        autoFocus
        value={name}
        placeholder="Nombre (p. ej. Contexto)"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <div className="insp-types">
        {TYPES.map((t) => (
          <button key={t.id} className={`chip${type === t.id ? ' on' : ''}`} onClick={() => setType(t.id)}>
            {t.name}
          </button>
        ))}
      </div>
      <div className="insp-new-actions">
        {clash && <span className="insp-warn">Ya existe</span>}
        <button className="btn" onClick={() => setOpen(false)}>
          Cancelar
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!name.trim() || clash}>
          Crear
        </button>
      </div>
    </div>
  );
}

// Cada opción tiene siempre el mismo tono, calculado a partir de su texto.
export function hueOf(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `${h}`;
}
