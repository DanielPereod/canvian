import { useEffect, useState } from 'react';
import { ACTIONS, bind, comboOf, isDefault, keyParts, reserved, resetAll, resetKey, useKeymap, type ActionId } from './keys';
import { Keys } from './Kbd';
import { setTheme, THEMES, useTheme } from './theme';

// Página de configuración: el tema, los atajos de teclado (ambos se guardan en
// el servidor, así que valen en todos tus dispositivos) y atajos a otros paneles.

type Props = {
  onClose: () => void;
  onBackground: () => void;
  onLab: () => void;
  onProfiles: () => void;
};

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];

export function Settings({ onClose, onBackground, onLab, onProfiles }: Props) {
  const keymap = useKeymap();
  const theme = useTheme();
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const label = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.label;

  const report = (p: Promise<unknown>) => p.catch(() => setNote('No se ha podido guardar en el servidor. Vuelve a intentarlo.'));

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

  return (
    <div className="page-view settings-view" data-keys-modal>
      <header className="page-top">
        <button className="sheet-back meta" onClick={onClose}>
          ← Volver
        </button>
      </header>
      <div className="page-body">
        <h1 className="display page-title">Configuración</h1>

        <section className="settings-section">
          <h2 className="settings-heading">Tema</h2>
          <p className="meta settings-hint">Cambia el aspecto de todo Canvian; el mapa y tus notas no cambian.</p>
          <div className="theme-grid" role="radiogroup" aria-label="Tema">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={theme === t.id}
                className={`theme-card${theme === t.id ? ' is-on' : ''}`}
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
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h2 className="settings-heading">Atajos de teclado</h2>
          <p className="meta settings-hint">Pulsa un atajo para cambiarlo. Se guardan en tu servidor y valen en todos tus dispositivos.</p>
          {note && (
            <p className="settings-note" role="status">
              {note}
            </p>
          )}
          {GROUPS.map((g) => (
            <div key={g} className="settings-group">
              <h3 className="settings-subheading">{g}</h3>
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div key={a.id} className={`settings-row${capturing === a.id ? ' is-capturing' : ''}`}>
                  <span className="settings-label">{a.label}</span>
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
                  <button
                    className="settings-reset meta"
                    style={{ visibility: isDefault(a.id) ? 'hidden' : 'visible' }}
                    onClick={() => report(resetKey(a.id))}
                    title={`Volver a ${keyParts(a.key).join(' ')}`}
                  >
                    Restablecer
                  </button>
                </div>
              ))}
            </div>
          ))}
          {custom && (
            <button className="sheet-link sheet-link-add" onClick={() => report(resetAll())}>
              Restablecer todos los atajos
            </button>
          )}
        </section>

        <section className="settings-section">
          <h2 className="settings-heading">Más</h2>
          <div className="settings-links">
            <button className="sheet-link" onClick={onBackground}>
              Fondo del perfil
            </button>
            <button className="sheet-link" onClick={onLab}>
              Laboratorio
            </button>
            <button className="sheet-link" onClick={onProfiles}>
              Perfiles y sesión
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
