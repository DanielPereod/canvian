import { useState, type CSSProperties } from 'react';
import { Wordmark } from './Wordmark';
import { Fireflies } from './Fireflies';

// Muestra viva del sistema de diseño: abre la app con #sistema en la URL.

const HUES = ['teal', 'amber', 'coral', 'sky', 'lilac', 'sage'];
const COLORS: [string, string][] = [
  ['--bg', 'Fondo'],
  ['--text', 'Texto'],
  ['--text-muted', 'Texto secundario'],
  ['--text-faint', 'Texto tenue'],
  ['--accent', 'Acento (perfil)'],
  ['--accent-ink', 'Texto en acento'],
  ['--danger', 'Error'],
  ['--success', 'Éxito'],
];
const TYPE: [string, React.ReactNode, string, CSSProperties?][] = [
  ['--text-2xl', <>Titular con <em>acento</em></>, '34 · Instrument Sans + Serif itálica', { letterSpacing: '-0.02em' }],
  ['--text-xl', 'Título en una nota o zona', '24 · Instrument Serif', { fontFamily: 'var(--font-serif)' }],
  ['--text-lg', 'Campos grandes', '18'],
  ['--text-ui', 'Controles y listas', '15 · Instrument Sans'],
  ['--text-md', 'Cuerpo de las notas', '14'],
  ['--text-sm', 'Secundario y atajos', '13'],
  ['--text-xs', 'ETIQUETAS', '12 · versalitas', { letterSpacing: '0.1em' }],
  ['--text-2xs', 'ZONA · META', '10 · Silkscreen', { fontFamily: 'var(--font-pixel)' }],
];
const SPACE = ['1', '2', '3', '4', '6', '8', '10'];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', 'pill'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sg-section">
      <h2 className="label">{title}</h2>
      {children}
    </section>
  );
}

export function Styleguide() {
  const [hue, setHue] = useState('teal');
  const [cursor, setCursor] = useState(0);

  const pick = (h: string) => {
    setHue(h);
    document.documentElement.style.setProperty('--accent', `var(--hue-${h})`);
  };

  return (
    <div className="backdrop dotted sg">
      <Fireflies count={24} />
      <div className="sg-page">
        <header className="sg-header">
          <Wordmark className="auth-brand" />
          <h1 className="display sg-title">
            Jardín <em>nocturno</em>
          </h1>
          <p className="muted">
            Tokens en <code>web/src/design/tokens.css</code>, componentes en <code>components.css</code>. El acento lo
            pone el perfil activo: prueba a cambiarlo.
          </p>
          <div className="sg-row">
            {HUES.map((h) => (
              <button
                key={h}
                className={`sg-hue${hue === h ? ' active' : ''}`}
                style={{ background: `var(--hue-${h})` } as CSSProperties}
                onClick={() => pick(h)}
                aria-label={`Acento ${h}`}
              />
            ))}
          </div>
        </header>

        <Section title="Color">
          <div className="sg-grid">
            {COLORS.map(([token, name]) => (
              <div key={token} className="surface-2 sg-swatch">
                <span className="sg-chip" style={{ background: `var(${token})` }} />
                <div>
                  <div>{name}</div>
                  <code className="faint">{token}</code>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Superficies">
          <div className="sg-grid">
            <div className="surface-1 sg-surface">
              <strong>Superficie 1</strong>
              <span className="muted">Notas. Opaca, sin blur.</span>
            </div>
            <div className="surface-2 sg-surface">
              <strong>Superficie 2</strong>
              <span className="muted">Cromo flotante. Glass ligero.</span>
            </div>
            <div className="surface-3 sg-surface">
              <strong>Superficie 3</strong>
              <span className="muted">Popovers y diálogos. Glass denso.</span>
            </div>
          </div>
        </Section>

        <Section title="Tipografía">
          <div className="surface-2 sg-card sg-type">
            {TYPE.map(([token, sample, meta, extra]) => (
              <div key={token} className="sg-type-row">
                <span className={token === '--text-2xl' ? 'display' : undefined} style={{ fontSize: `var(${token})`, ...extra }}>
                  {sample}
                </span>
                <code className="faint">{meta}</code>
              </div>
            ))}
            <div className="sg-type-row">
              <code>JetBrains Mono · código y teclas</code>
              <code className="faint">--font-mono</code>
            </div>
          </div>
        </Section>

        <Section title="Espacio y radios">
          <div className="surface-2 sg-card sg-row sg-wrap">
            {SPACE.map((s) => (
              <div key={s} className="sg-measure">
                <span className="sg-bar" style={{ width: `var(--space-${s})` }} />
                <code className="faint">{s}</code>
              </div>
            ))}
          </div>
          <div className="sg-row sg-wrap">
            {RADII.map((r) => (
              <div key={r} className="surface-2 sg-radius" style={{ borderRadius: `var(--radius-${r})` }}>
                <code className="faint">{r}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Componentes">
          <div className="sg-grid">
            <div className="surface-2 sg-card sg-stack">
              <div className="sg-row">
                <button className="btn btn-primary">Crear y entrar</button>
                <button className="btn btn-ghost">Cancelar</button>
              </div>
              <input id="sg-field" className="field" placeholder="Campo de texto" />
              <div className="sg-row faint">
                <kbd>Ctrl</kbd>
                <kbd>K</kbd>
                <span>buscar</span>
              </div>
              <div className="sg-row">
                <span className="surface-2 pill">
                  <span className="dot" />
                  <span className="pill-name">Personal</span>
                </span>
                <span className="meta">Zona · meta</span>
              </div>
            </div>

            <div className="surface-3 popover sg-static">
              <input id="sg-popover" className="field field-bare" placeholder="Buscar notas o crear una" />
              <div className="popover-divider" />
              <div className="label">Recientes</div>
              <ul className="list" role="listbox">
                {['Reservar alojamiento', 'Comparar vuelos', 'Presupuesto del viaje'].map((t, i) => (
                  <li
                    key={t}
                    className="list-item"
                    style={{ '--i': i } as CSSProperties}
                    role="option"
                    aria-selected={i === cursor}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <div className="hit">
                      <span className="hit-title">{t}</span>
                    </div>
                  </li>
                ))}
                <li className="list-item" role="option" aria-selected={cursor === 3} onMouseEnter={() => setCursor(3)}>
                  <span className="list-icon">+</span>
                  Crear nota «viaje»
                </li>
              </ul>
            </div>
          </div>
        </Section>

        <Section title="Movimiento">
          <div className="surface-2 sg-card sg-motion">
            <p className="muted">
              Todo entra con muelle y sale rápido. Una nota se abre fundiéndose en el lector, y al cambiar de perfil el
              color de la luz se funde en casi un segundo.
            </p>
            <ul className="sg-motion-list">
              <li><code>--ease-spring</code> entradas, botones, asas</li>
              <li><code>--ease-out</code> popovers, tallos, desvanecidos</li>
              <li><code>--ease-in</code> salidas</li>
              <li><code>--dur-fast 160</code> · <code>--dur-base 260</code> · <code>--dur-slow 440</code> · <code>--dur-grow 720</code> · <code>--dur-mood 900</code></li>
            </ul>
          </div>
        </Section>

        <Section title="Avisos">
          <div className="surface-3 toast toast-danger sg-static">
            No se pudo guardar el último cambio. Revisa que el servidor sigue en marcha.
          </div>
        </Section>
      </div>
    </div>
  );
}
