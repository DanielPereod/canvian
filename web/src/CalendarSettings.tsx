import { useState, type CSSProperties } from 'react';
import { t } from './i18n';
import { addCalendar, CAL_COLORS, refreshCalendars, removeCalendar, updateCalendar, useCalendarEvents, useCalendars } from './calendars';
import { localToday } from './canvas/dates';

// Configuración › Calendarios: los calendarios de fuera que salen en el
// calendario de tareas. Se añaden con su enlace iCal y solo se leen.

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const looksLikeUrl = (s: string) => /^(https?|webcals?):\/\/\S+$/i.test(s.trim());

export function CalendarSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const list = useCalendars();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [bad, setBad] = useState(false);
  // Para saber cuáles no se pueden leer: los eventos de este mes.
  const today = new Date(localToday());
  const { errors } = useCalendarEvents(isoOf(today), isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 31)));

  const add = () => {
    if (!looksLikeUrl(url)) {
      setBad(true);
      return;
    }
    const guess = name.trim() || (() => {
      try {
        return new URL(url.trim().replace(/^webcals?:/i, 'https:')).hostname.replace(/^www\./, '');
      } catch {
        return t('Calendario');
      }
    })();
    report(addCalendar(guess.slice(0, 80), url));
    setName('');
    setUrl('');
    setBad(false);
  };

  const nextColor = (c: string) => CAL_COLORS[(CAL_COLORS.indexOf(c) + 1) % CAL_COLORS.length];

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Los eventos de tus otros calendarios salen en el calendario de tareas, con su color. Solo se leen: para cambiarlos, hazlo en su aplicación. Se actualizan cada 15 minutos.')}
      </p>
      {list.map((c) => (
        <div key={c.id} className={`set-row cal-set-row${c.on ? '' : ' is-off'}`}>
          <button
            className="cal-set-color"
            style={{ '--ev': c.color } as CSSProperties}
            onClick={() => report(updateCalendar(c.id, { color: nextColor(c.color) }))}
            title={t('Cambiar el color')}
            aria-label={t('Cambiar el color')}
          />
          <div className="set-info cal-set-info">
            <input
              className="cal-set-name"
              defaultValue={c.name}
              aria-label={t('Nombre del calendario')}
              maxLength={80}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== c.name) report(updateCalendar(c.id, { name: v }));
                else e.currentTarget.value = c.name;
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <div className="set-hint cal-set-url" title={c.url}>
              {c.url}
            </div>
            {c.on && errors[c.id] && <div className="cal-set-error">{t(errors[c.id])}</div>}
          </div>
          <div className="set-control">
            <div className="set-segmented" role="radiogroup" aria-label={t('Mostrar en el calendario')}>
              <button role="radio" aria-checked={c.on} className={c.on ? 'is-on' : ''} onClick={() => report(updateCalendar(c.id, { on: true }))}>
                {t('Visible')}
              </button>
              <button role="radio" aria-checked={!c.on} className={!c.on ? 'is-on' : ''} onClick={() => report(updateCalendar(c.id, { on: false }))}>
                {t('Oculto')}
              </button>
            </div>
            <button className="settings-reset meta" onClick={() => report(removeCalendar(c.id))}>
              {t('Quitar')}
            </button>
          </div>
        </div>
      ))}
      {!list.length && <p className="set-hint cal-set-empty">{t('Aún no hay ninguno.')}</p>}

      <form
        className="set-block cal-set-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="set-name">{t('Añadir un calendario')}</div>
        <div className="set-hint">
          {t('Pega su enlace iCal (.ics). En Google Calendar: Configuración › tu calendario › «Dirección secreta en formato iCal». En Outlook: Configuración › Calendario › Calendarios compartidos › Publicar un calendario › ICS. En Apple: comparte el calendario como público y copia el enlace webcal://.')}
        </div>
        <div className="cal-set-fields">
          <input className="field" placeholder={t('Nombre (opcional)')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <input
            className="field cal-set-urlfield"
            placeholder="https://… .ics"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setBad(false);
            }}
            aria-invalid={bad}
          />
          <button className="set-button" type="submit" disabled={!url.trim() || list.length >= 30}>
            {t('Añadir')}
          </button>
        </div>
        {bad && <div className="cal-set-error">{t('Ese enlace no parece válido: tiene que empezar por https:// o webcal://.')}</div>}
      </form>

      {list.some((c) => c.on) && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Actualizar ahora')}</div>
            <div className="set-hint">{t('Vuelve a descargar los calendarios sin esperar.')}</div>
          </div>
          <div className="set-control">
            <button className="set-button" onClick={refreshCalendars}>
              {t('Actualizar')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
