import { useEffect, useMemo, useState } from 'react';
import { api, type NoteRow, type Profile } from './api';
import { CopyBox } from './AiSettings';
import { getLang, t } from './i18n';
import { Combo } from './canvas/Combo';

// Configuración › KOReader: el plugin que manda los subrayados y notas de tus
// libros a Canvian. Se descarga ya configurado (dirección, llave y perfil) y
// aquí se elige en qué nota se guardan los libros de cada perfil.

type Status = { token: string | null; publicUrl: string | null; folders: Record<string, string | null> };

const ACTIVE_KEY = 'canvian.activeProfile';
const activeProfile = () => {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
};

// «Abuela › Madre › Nota» de cada nota de texto, para elegir la carpeta.
function folderOptions(notes: NoteRow[]) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const pathOf = (n: NoteRow) => {
    const parts = [n.title?.trim() || t('Nota sin título')];
    let up = n.zoneId ? byId.get(n.zoneId) : undefined;
    for (let hops = 0; up && hops < 50; hops++) {
      parts.unshift(up.title?.trim() || t('Nota sin título'));
      up = up.zoneId ? byId.get(up.zoneId) : undefined;
    }
    return parts.join(' › ');
  };
  return notes
    .filter((n) => n.kind === 'text' && !n.archivedAt)
    .map((n) => ({ id: n.id, path: pathOf(n) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function KoreaderSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [showKey, setShowKey] = useState(false);

  const refresh = () => api.koreaderStatus().then(setStatus);
  useEffect(() => {
    refresh().catch(() => setStatus({ token: null, publicUrl: null, folders: {} }));
    api.profiles().then((list) => {
      setProfiles(list);
      const saved = activeProfile();
      setProfileId(list.find((p) => p.id === saved)?.id ?? list[0]?.id ?? null);
    }, () => {});
  }, []);
  useEffect(() => {
    if (!profileId) return;
    setNotes(null);
    api.canvas(profileId).then((c) => setNotes(c.notes), () => setNotes([]));
  }, [profileId]);

  const options = useMemo(() => folderOptions(notes ?? []), [notes]);
  const base = status?.publicUrl || location.origin;
  const folder = profileId ? (status?.folders[profileId] ?? null) : null;
  const download = profileId
    ? `/api/koreader/plugin.zip?profile=${encodeURIComponent(profileId)}&base=${encodeURIComponent(base)}&lang=${getLang()}`
    : null;
  const local = !status?.publicUrl && (location.protocol !== 'https:' || /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname));

  const pickFolder = (noteId: string) => {
    if (!profileId) return;
    report(api.setKoreaderFolder(profileId, noteId || null).then(setStatus));
  };
  const savePublic = (raw: string) => {
    const url = raw.trim().replace(/\/+$/, '');
    if ((url || null) === (status?.publicUrl ?? null)) return;
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) return;
    report(api.setMcpPublicUrl(url || null).then(refresh));
  };
  const newKey = () => {
    if (status?.token && !window.confirm(t('KOReader dejará de poder sincronizar hasta que pongas la llave nueva en el plugin (o lo vuelvas a descargar). ¿Crear otra?'))) return;
    report(api.createKoreaderToken().then(refresh));
  };
  const revoke = () => {
    if (!window.confirm(t('KOReader dejará de poder mandar subrayados. ¿Desactivar?'))) return;
    report(api.revokeKoreaderToken().then(refresh));
  };

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Manda a Canvian los subrayados y notas de los libros que lees en KOReader. Cada libro es una nota, dentro de la carpeta que elijas. Volver a sincronizar actualiza la nota del libro, no la duplica; lo que escribas encima de «Subrayados» se conserva.')}
      </p>

      {profiles.length > 1 && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Perfil')}</div>
            <div className="set-hint">{t('El que se usa al descargar el plugin y cuya carpeta eliges aquí. En KOReader se puede cambiar desde el menú del plugin.')}</div>
          </div>
          <div className="set-control">
            <Combo className="set-combo" items={profiles.map((p) => ({ id: p.id, label: p.name }))} value={profileId} label={t('Perfil')} onChange={setProfileId} />
          </div>
        </div>
      )}

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Carpeta')}</div>
          <div className="set-hint">{t('La nota en la que se guardan los libros. Sin elegir ninguna, se crea la nota «KOReader».')}</div>
        </div>
        <div className="set-control">
          <Combo
            className="set-combo kor-folder"
            items={[{ id: '', label: t('«KOReader» (automática)') }, ...options.map((o) => ({ id: o.id, label: o.path }))]}
            value={folder ?? ''}
            missing={notes ? t('Nota archivada o borrada') : undefined}
            disabled={!notes || !status}
            label={t('Carpeta')}
            search
            onChange={pickFolder}
          />
        </div>
      </div>

      {status && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Dirección pública')}</div>
            <div className="set-hint">
              {t('Con la que KOReader llega a Canvian (la misma que usan los asistentes IA). Si solo lees en casa, también vale la dirección local.')}
              {local && <span className="cal-set-error"> {t('Ahora usas una dirección local: pon aquí la pública si quieres sincronizar fuera de casa.')}</span>}
            </div>
          </div>
          <div className="set-control">
            <input
              className="field ai-public"
              key={status.publicUrl ?? ''}
              defaultValue={status.publicUrl ?? ''}
              placeholder={location.origin}
              aria-label={t('Dirección pública')}
              onBlur={(e) => savePublic(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </div>
        </div>
      )}

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Plugin')}</div>
          <div className="set-hint">{t('Ya lleva puestos la dirección, la llave y el perfil.')}</div>
        </div>
        <div className="set-control">
          {download && (
            <a className="set-button" href={download} download="canvian.koplugin.zip" onClick={() => setTimeout(() => void refresh().catch(() => {}), 1500)}>
              {t('Descargar plugin')}
            </a>
          )}
        </div>
      </div>

      <div className="set-block">
        <div className="set-name">{t('Cómo instalarlo')}</div>
        <ol className="set-hint kor-steps">
          <li>{t('Descomprime el .zip: sale la carpeta canvian.koplugin.')}</li>
          <li>{t('Cópiala dentro de la carpeta koreader/plugins del lector (en Kobo, .adds/koreader/plugins; en Android, koreader/plugins en la memoria interna).')}</li>
          <li>{t('Reinicia KOReader. En el menú de herramientas (la llave inglesa) aparece Canvian.')}</li>
          <li>{t('Elige «Sincronizar este libro» con un libro abierto, o «Sincronizar todos los libros» para mandar los del historial. También puede sincronizar sola al cerrar cada libro.')}</li>
        </ol>
      </div>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Llave')}</div>
          <div className="set-hint">
            {status === null
              ? '…'
              : status.token
                ? t('Quien la tenga puede añadir notas a tus perfiles. Si se filtra, crea otra y vuelve a descargar el plugin.')
                : t('Aún no hay ninguna: se crea al descargar el plugin.')}
          </div>
        </div>
        {status && (
          <div className="set-control">
            {status.token && (
              <button className="settings-reset meta" onClick={() => setShowKey((v) => !v)}>
                {showKey ? t('Ocultar') : t('Ver')}
              </button>
            )}
            <button className="set-button" onClick={newKey}>
              {status.token ? t('Crear otra') : t('Crear llave')}
            </button>
            {status.token && (
              <button className="settings-reset meta" onClick={revoke}>
                {t('Desactivar')}
              </button>
            )}
          </div>
        )}
      </div>
      {showKey && status?.token && <CopyBox text={status.token} label={t('Llave')} />}
    </>
  );
}
