import { useEffect, useState, type ReactNode } from 'react';
import { LANGS, setLang, t, useLang } from './i18n';
import { ACTIONS, bind, comboOf, groupName, isDefault, keyParts, reserved, resetAll, resetKey, useKeymap, type ActionId } from './keys';
import { Keys } from './Kbd';
import { MODES, setMode, setTheme, THEMES, useAppearance, type Tone } from './theme';
import { SIZES, SLOTS, THEME, setTypography, useTypography } from './typography';
import { FontPicker } from './FontPicker';
import { openOrganize } from './canvas/OrganizeView';
import { BackArrow } from './BackArrow';
import { CalendarSettings } from './CalendarSettings';
import { AiSettings } from './AiSettings';
import { KoreaderSettings } from './KoreaderSettings';
import { setZenFullscreen, useZenPrefs } from './canvas/zenPrefs';

// Configuración con la forma de Obsidian: a la izquierda las secciones, a la
// derecha los ajustes de la elegida, cada uno con su nombre y explicación a la
// izquierda y el control a la derecha. Todo se guarda en el servidor.

type Props = {
  onClose: () => void;
  onProfiles: () => void;
};

type SectionId = 'general' | 'aspecto' | 'calendarios' | 'asistentes' | 'koreader' | 'atajos';

const SECTIONS: { id: SectionId; name: string }[] = [
  { id: 'general', name: 'General' },
  { id: 'aspecto', name: 'Aspecto' },
  { id: 'calendarios', name: 'Calendarios' },
  { id: 'asistentes', name: 'Asistentes IA' },
  { id: 'koreader', name: 'KOReader' },
  { id: 'atajos', name: 'Atajos de teclado' },
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

export function Settings({ onClose, onProfiles }: Props) {
  const keymap = useKeymap();
  const look = useAppearance();
  const type = useTypography();
  const lang = useLang();
  const zen = useZenPrefs();
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

  const report = (p: Promise<unknown>) => p.catch(() => setNote(t('No se ha podido guardar en el servidor. Vuelve a intentarlo.')));

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
          setNote(t('{key} está reservada; elige otra.', { key: keyParts(combo).join(' ') }));
          return;
        }
        const { swapped, done } = bind(capturing, combo);
        report(done);
        setNote(swapped ? t('«{name}» usaba esa tecla y ahora tiene la que dejaste libre.', { name: label(swapped) }) : null);
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
  const shown = ACTIONS.filter((a) => words.every((w) => norm(`${a.label} ${a.hint ?? ''} ${keyParts(keymap[a.id]).join(' ')}`).includes(w)));

  const themes = (tone: Tone) => (
    <div className="theme-grid" role="radiogroup" aria-label={tone === 'dark' ? t('Tema oscuro') : t('Tema claro')}>
      {THEMES.filter((th) => th.tone === tone).map((th) => {
        const on = look[tone] === th.id;
        return (
          <button
            key={th.id}
            role="radio"
            aria-checked={on}
            className={`theme-card${on ? ' is-on' : ''}`}
            onClick={() => {
              setNote(null);
              report(setTheme(th.id));
            }}
          >
            <span className={`theme-swatch t-${th.id}`} aria-hidden="true">
              <i />
              <i />
              <i />
              <b>Aa</b>
            </span>
            <span className="theme-name">{t(th.name)}</span>
            <span className="theme-hint meta">{t(th.hint)}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="page-view settings-view" data-keys-modal>
      <div className="set-shell">
        <nav className="set-nav" aria-label={t('Secciones')}>
          <button className="sheet-back meta set-back" onClick={onClose}>
            <BackArrow /> {t('Volver')}
          </button>
          <div className="set-nav-title">{t('Configuración')}</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`set-nav-item${section === s.id ? ' is-on' : ''}`} aria-current={section === s.id} onClick={() => go(s.id)}>
              {t(s.name)}
            </button>
          ))}
          <div className="set-nav-title">{t('Más')}</div>
          <button className="set-nav-item" onClick={onProfiles}>
            {t('Perfiles y sesión')}
          </button>
        </nav>

        <main className="set-main" key={section}>
          <div className="set-main-inner">
          <h1 className="set-title">{t(SECTIONS.find((s) => s.id === section)!.name)}</h1>
          {note && (
            <p className="settings-note" role="status">
              {note}
            </p>
          )}

          {section === 'general' && (
            <>
              <Row name={t('Idioma')} hint={t('El de la interfaz. Sin elegir, el del navegador.')}>
                <div className="set-segmented" role="radiogroup" aria-label={t('Idioma')}>
                  {LANGS.map((l) => (
                    <button key={l.id} role="radio" lang={l.id} aria-checked={lang === l.id} className={lang === l.id ? 'is-on' : ''} onClick={() => report(setLang(l.id))}>
                      {l.name}
                    </button>
                  ))}
                </div>
              </Row>
              <Row name={t('Modo zen')} hint={t('Al entrar en el modo zen, poner también el navegador a pantalla completa. Al salir de la pantalla completa se sale del modo zen.')}>
                <div className="set-segmented" role="radiogroup" aria-label={t('Modo zen')}>
                  {[
                    { on: false, label: t('En la ventana') },
                    { on: true, label: t('Pantalla completa') },
                  ].map((o) => (
                    <button key={String(o.on)} role="radio" aria-checked={zen.fullscreen === o.on} className={zen.fullscreen === o.on ? 'is-on' : ''} onClick={() => report(setZenFullscreen(o.on))}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </Row>
              <Row name={t('Ordenar notas')} hint={t('Revisa las notas sueltas y mételas dentro de otras.')}>
                <button
                  className="set-button"
                  onClick={() => {
                    onClose();
                    openOrganize();
                  }}
                >
                  {t('Abrir')}
                </button>
              </Row>
              <Row name={t('Perfiles y sesión')} hint={t('Cambia de perfil, crea otros o cierra la sesión.')}>
                <button className="set-button" onClick={onProfiles}>
                  {t('Abrir')}
                </button>
              </Row>
              <Row name={t('Dónde se guarda')} hint={t('La configuración vive en tu servidor y es la misma en todos tus dispositivos.')} />
            </>
          )}

          {section === 'aspecto' && (
            <>
              <Row name={t('Modo')} hint={t('Automático sigue al sistema: claro de día, oscuro de noche. También con Ctrl Mayús L o desde la paleta de comandos.')}>
                <div className="set-segmented" role="radiogroup" aria-label={t('Modo')}>
                  {MODES.map((m) => (
                    <button key={m.id} role="radio" aria-checked={look.mode === m.id} className={look.mode === m.id ? 'is-on' : ''} onClick={() => report(setMode(m.id))}>
                      {t(m.name)}
                    </button>
                  ))}
                </div>
              </Row>
              {SLOTS.map((s) => (
                <Row key={s.id} name={t(s.name)} hint={t(s.hint)}>
                  <FontPicker value={type[s.id]} sameAsUi={s.sameAsUi} label={t(s.name)} onPick={(id) => report(setTypography({ [s.id]: id }))} />
                </Row>
              ))}
              <div className="set-block">
                <div className="set-row-head">
                  <div className="set-name">{t('Muestra')}</div>
                  {SLOTS.some((s) => type[s.id] !== THEME) && (
                    <button className="set-button" onClick={() => report(setTypography({ ui: THEME, titles: THEME, text: THEME, code: THEME }))}>
                      {t('Volver a las del tema')}
                    </button>
                  )}
                </div>
                <div className="type-sample" aria-hidden>
                  <div className="type-sample-title">{t('Cuaderno de campo')}</div>
                  <p className="type-sample-text">
                    {t('El río bajaba crecido después de la tormenta. Apunté la hora, el color del agua y las')} <em>{t('tres garzas')}</em> {t('que esperaban en la orilla.')}
                  </p>
                  <code className="type-sample-code">const garzas = avistamientos.filter((a) =&gt; a.especie === 'garza');</code>
                  <div className="type-sample-ui">
                    <span>{t('Biblioteca')}</span>
                    <span>{t('12 notas')}</span>
                    <span>{t('Editado hace 3 min')}</span>
                  </div>
                </div>
              </div>
              <Row name={t('Tamaño del texto')} hint={t('Escala toda la interfaz; Estándar es 14 px.')}>
                <div className="set-segmented" role="radiogroup" aria-label={t('Tamaño del texto')}>
                  {SIZES.map((z) => (
                    <button key={z.px} role="radio" aria-checked={type.size === z.px} className={type.size === z.px ? 'is-on' : ''} onClick={() => report(setTypography({ size: z.px }))}>
                      {t(z.name)}
                    </button>
                  ))}
                </div>
              </Row>
              <div className="set-block">
                <div className="set-name">{t('Tema oscuro')}</div>
                <div className="set-hint">{t('El que se usa en modo oscuro.')}</div>
                {themes('dark')}
              </div>
              <div className="set-block">
                <div className="set-name">{t('Tema claro')}</div>
                <div className="set-hint">{t('El que se usa en modo claro.')}</div>
                {themes('light')}
              </div>
            </>
          )}

          {section === 'calendarios' && <CalendarSettings report={report} />}

          {section === 'asistentes' && <AiSettings report={report} />}

          {section === 'koreader' && <KoreaderSettings report={report} />}

          {section === 'atajos' && (
            <>
              <div className="set-toolbar">
                <input className="field set-search" placeholder={t('Filtrar atajos…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                {custom && (
                  <button className="set-button" onClick={() => report(resetAll())}>
                    {t('Restablecer todos')}
                  </button>
                )}
              </div>
              {GROUPS.map((g) => {
                const list = shown.filter((a) => a.group === g);
                if (!list.length) return null;
                return (
                  <div key={g} className="settings-group">
                    <h3 className="settings-subheading">{groupName(g)}</h3>
                    {list.map((a) => (
                      <div key={a.id} className={`set-row${capturing === a.id ? ' is-capturing' : ''}`}>
                        <div className="set-info">
                          <div className="set-name">{a.label}</div>
                          {a.hint && <div className="set-hint">{a.hint}</div>}
                        </div>
                        <div className="set-control">
                          {keymap[a.id] && capturing !== a.id && (
                            <button className="settings-reset meta" onClick={() => report(bind(a.id, '').done)} title={t('Dejarlo sin tecla; sigue en la paleta de comandos')}>
                              {t('Quitar')}
                            </button>
                          )}
                          {!isDefault(a.id) && (
                            <button className="settings-reset meta" onClick={() => report(resetKey(a.id))} title={t('Volver a {key}', { key: keyParts(a.key).join(' ') })}>
                              {t('Restablecer')}
                            </button>
                          )}
                          <button
                            className="settings-key"
                            onClick={() => {
                              setNote(null);
                              setCapturing(capturing === a.id ? null : a.id);
                            }}
                            aria-label={t('Cambiar el atajo de {name}', { name: a.label })}
                          >
                            {capturing === a.id ? <span className="meta">{t('Pulsa la combinación · Esc cancela')}</span> : <Keys combo={keymap[a.id]} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
              {!shown.length && <p className="set-hint">{t('Ningún atajo se llama así.')}</p>}
            </>
          )}
          </div>
        </main>
      </div>
    </div>
  );
}
