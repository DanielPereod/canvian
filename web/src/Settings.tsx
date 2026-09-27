import { useEffect, useState, type ReactNode } from 'react';
import { ACTIONS, bind, comboOf, isDefault, keyParts, reserved, resetAll, resetKey, useKeymap, type ActionId } from './keys';
import { Keys } from './Kbd';
import { MODES, setMode, setTheme, THEMES, useAppearance, type Tone } from './theme';
import { EXPERIMENTS, toggleExperiment, useExperiments } from './lab/experiments';
import { openOrganize } from './canvas/OrganizeView';

// Configuración con la forma de Obsidian: a la izquierda las secciones, a la
// derecha los ajustes de la elegida, cada uno con su nombre y explicación a la
// izquierda y el control a la derecha. Todo se guarda en el servidor.

type Props = {
  onClose: () => void;
  onBackground: () => void;
  onLab: () => void;
  onProfiles: () => void;
};

type SectionId = 'general' | 'aspecto' | 'atajos' | 'laboratorio';

const SECTIONS: { id: SectionId; name: string }[] = [
  { id: 'general', name: 'General' },
  { id: 'aspecto', name: 'Aspecto' },
  { id: 'atajos', name: 'Atajos de teclado' },
  { id: 'laboratorio', name: 'Laboratorio' },
];

const LAST = 'canvian:settings-section';
const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function Row({ name, hint, children }: { name: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-info">
        <div className="set-name">{name}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle${on ? ' is-on' : ''}`} onClick={onChange} />;
}

export function Settings({ onClose, onBackground, onLab, onProfiles }: Props) {
  const keymap = useKeymap();
  const look = useAppearance();
  const experiments = useExperiments();
  const [section, setSection] = useState<SectionId>(() => {
    try {
      const saved = localStorage.getItem(LAST);
      return SECTIONS.some((s) => s.id === saved) ? (saved as SectionId) : 'general';
    } catch {
      return 'general';
    }
  });
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const label = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.label;

  const report = (p: Promise<unknown>) => p.catch(() => setNote('No se ha podido guardar en el servidor. Vuelve a intentarlo.'));

  const go = (id: SectionId) => {
    setSection(id);
    setNote(null);
    setCapturing(null);
    try {
      localStorage.setItem(LAST, id);
    } catch {
      // Sin almacenamiento local se abre siempre en General.
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setCapturing(null);
          return;
        }
        const combo = comboOf(e);
        if (!combo) return;
        if (reserved(combo)) {
          setNote(`${keyParts(combo).join(' ')} está reservada; elige otra.`);
          return;
        }
        const { swapped, done } = bind(capturing, combo);
        report(done);
        setNote(swapped ? `«${label(swapped)}» usaba esa tecla y ahora tiene la que dejaste libre.` : null);
        setCapturing(null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const custom = ACTIONS.some((a) => !isDefault(a.id));
  const words = norm(filter).split(/\s+/).filter(Boolean);
  const shown = ACTIONS.filter((a) => words.every((w) => norm(`${a.label} ${keyParts(keymap[a.id]).join(' ')}`).includes(w)));

  const themes = (tone: Tone) => (
    <div className="theme-grid" role="radiogroup" aria-label={tone === 'dark' ? 'Tema oscuro' : 'Tema claro'}>
      {THEMES.filter((t) => t.tone === tone).map((t) => {
        const on = look[tone] === t.id;
        return (
          <button
            key={t.id}
            role="radio"
            aria-checked={on}
            className={`theme-card${on ? ' is-on' : ''}`}
            onClick={() => {
              setNote(null);
              report(setTheme(t.id));
            }}
          >
            <span className={`theme-swatch t-${t.id}`} aria-hidden="true">
              <i />
              <i />
              <i />
              <b>Aa</b>
            </span>
            <span className="theme-name">{t.name}</span>
            <span className="theme-hint meta">{t.hint}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="page-view settings-view" data-keys-modal>
      <div className="set-shell">
        <nav className="set-nav" aria-label="Secciones">
          <button className="sheet-back meta set-back" onClick={onClose}>
            ← Volver
          </button>
          <div className="set-nav-title">Configuración</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`set-nav-item${section === s.id ? ' is-on' : ''}`} aria-current={section === s.id} onClick={() => go(s.id)}>
              {s.name}
            </button>
          ))}
          <div className="set-nav-title">Más</div>
          <button className="set-nav-item" onClick={onProfiles}>
            Perfiles y sesión
          </button>
          <button className="set-nav-item" onClick={onBackground}>
            Fondo del perfil
          </button>
        </nav>

        <main className="set-main" key={section}>
          <h1 className="set-title">{SECTIONS.find((s) => s.id === section)!.name}</h1>
          {note && (
            <p className="settings-note" role="status">
              {note}
            </p>
          )}

          {section === 'general' && (
            <>
              <Row name="Ordenar notas" hint="Revisa las notas sueltas y mételas dentro de otras.">
                <button
                  className="set-button"
                  onClick={() => {
                    onClose();
                    openOrganize();
                  }}
                >
                  Abrir
                </button>
              </Row>
              <Row name="Perfiles y sesión" hint="Cambia de perfil, crea otros o cierra la sesión.">
                <button className="set-button" onClick={onProfiles}>
                  Abrir
                </button>
              </Row>
              <Row name="Fondo del perfil" hint="El fondo que se ve detrás del mapa en este perfil.">
                <button className="set-button" onClick={onBackground}>
                  Elegir
                </button>
              </Row>
              <Row name="Dónde se guarda" hint="La configuración vive en tu servidor y es la misma en todos tus dispositivos." />
            </>
          )}

          {section === 'aspecto' && (
            <>
              <Row name="Modo" hint="Automático sigue al sistema: claro de día, oscuro de noche. También con Ctrl Mayús L o desde la paleta de comandos.">
                <div className="set-segmented" role="radiogroup" aria-label="Modo">
                  {MODES.map((m) => (
                    <button key={m.id} role="radio" aria-checked={look.mode === m.id} className={look.mode === m.id ? 'is-on' : ''} onClick={() => report(setMode(m.id))}>
                      {m.name}
                    </button>
                  ))}
                </div>
              </Row>
              <div className="set-block">
                <div className="set-name">Tema oscuro</div>
                <div className="set-hint">El que se usa en modo oscuro.</div>
                {themes('dark')}
              </div>
              <div className="set-block">
                <div className="set-name">Tema claro</div>
                <div className="set-hint">El que se usa en modo claro.</div>
                {themes('light')}
              </div>
            </>
          )}

          {section === 'atajos' && (
            <>
              <div className="set-toolbar">
                <input className="field set-search" placeholder="Filtrar atajos…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {custom && (
                  <button className="set-button" onClick={() => report(resetAll())}>
                    Restablecer todos
                  </button>
                )}
              </div>
              {GROUPS.map((g) => {
                const list = shown.filter((a) => a.group === g);
                if (!list.length) return null;
                return (
                  <div key={g} className="settings-group">
                    <h3 className="settings-subheading">{g}</h3>
                    {list.map((a) => (
                      <div key={a.id} className={`set-row${capturing === a.id ? ' is-capturing' : ''}`}>
                        <div className="set-info">
                          <div className="set-name">{a.label}</div>
                        </div>
                        <div className="set-control">
                          {!isDefault(a.id) && (
                            <button className="settings-reset meta" onClick={() => report(resetKey(a.id))} title={`Volver a ${keyParts(a.key).join(' ')}`}>
                              Restablecer
                            </button>
                          )}
                          <button
                            className="settings-key"
                            onClick={() => {
                              setNote(null);
                              setCapturing(capturing === a.id ? null : a.id);
                            }}
                            aria-label={`Cambiar el atajo de ${a.label}`}
                          >
                            {capturing === a.id ? <span className="meta">Pulsa la combinación · Esc cancela</span> : <Keys combo={keymap[a.id]} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {!shown.length && <p className="set-hint">Ningún atajo se llama así.</p>}
            </>
          )}

          {section === 'laboratorio' && (
            <>
              <p className="set-hint set-intro">Ideas en prueba. Enciéndelas o apágalas para compararlas; se guardan en tu servidor.</p>
              {EXPERIMENTS.map((x) => (
                <Row key={x.id} name={x.name} hint={x.hint}>
                  <Toggle on={experiments[x.id]} label={x.name} onChange={() => toggleExperiment(x.id)} />
                </Row>
              ))}
              <Row name="Panel del laboratorio" hint="El mismo panel que abre la tecla E.">
                <button className="set-button" onClick={onLab}>
                  Abrir
                </button>
              </Row>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
