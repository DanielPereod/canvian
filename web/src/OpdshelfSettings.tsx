import { useEffect, useState } from 'react';
import { api, type OpdshelfStatus, type Profile } from './api';
import { t } from './i18n';
import { Combo } from './canvas/Combo';

// Configuración › opdshelf: Canvian lee los subrayados y notas de tu servidor
// de libros (que ya junta los de KOReader, la app de Android y el lector web).
// Los libros van a las mismas notas y a la misma carpeta que los de KOReader.

export function OpdshelfSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<OpdshelfStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (s: OpdshelfStatus) => {
    setStatus(s);
    setUrl(s.config?.url ?? '');
    setUsername(s.config?.username ?? '');
    setProfileId(s.config?.profileId ?? null);
  };
  useEffect(() => {
    api.opdshelfStatus().then(load, () => setStatus({ config: null, lastSync: null, lastError: null, books: 0 }));
    api.profiles().then(setProfiles, () => {});
  }, []);

  const valid = /^https?:\/\/[^\s/]+/.test(url.trim());
  const save = () => {
    if (!valid) return;
    setError(null);
    report(
      api
        .setOpdshelf({
          url: url.trim(),
          username: username.trim() || null,
          // Vacío: se queda la que ya había.
          ...(password ? { password } : {}),
          ...(key.trim() ? { key: key.trim() } : {}),
          profileId,
        })
        .then((s) => {
          load(s);
          setPassword('');
          setKey('');
        }),
    );
  };
  const forgetKey = () => report(api.setOpdshelf({ url: url.trim(), username: username.trim() || null, key: null, profileId }).then(load));
  const sync = (all: boolean) => {
    setBusy(true);
    setResult(null);
    setError(null);
    api
      .syncOpdshelf(all)
      .then(
        (r) => {
          setStatus(r.status);
          setResult(t('Libros nuevos: %1 · actualizados: %2').replace('%1', String(r.created)).replace('%2', String(r.updated)));
        },
        (e: Error) => {
          setError(e.message);
          api.opdshelfStatus().then(setStatus, () => {});
        },
      )
      .finally(() => setBusy(false));
  };
  const remove = () => {
    if (!window.confirm(t('Canvian dejará de leer opdshelf. Las notas de los libros se quedan. ¿Quitar la conexión?'))) return;
    report(api.removeOpdshelf().then(() => api.opdshelfStatus().then(load)));
  };

  const c = status?.config ?? null;
  const when = status?.lastSync ? new Date(status.lastSync).toLocaleString() : null;

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Canvian lee de tu servidor opdshelf los subrayados y notas de todos tus libros (de KOReader, la app de Android o el navegador) y los guarda como una nota por libro, en la carpeta elegida en KOReader. Cada subrayado lleva su ^id, así que los enlaces a un subrayado siguen funcionando aunque se vuelva a sincronizar. Se pone al día solo, en cuanto opdshelf avisa de un cambio.')}
      </p>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Dirección')}</div>
          <div className="set-hint">{t('La de opdshelf, sin /admin.')}</div>
        </div>
        <div className="set-control">
          <input className="field ai-public" value={url} placeholder="https://opd.example.org" aria-label={t('Dirección')} onChange={(e) => setUrl(e.target.value)} />
        </div>
      </div>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Llave de API')}</div>
          <div className="set-hint">
            {c?.hasKey ? t('Guardada. Se usa antes que el usuario y la contraseña.') : t('La que crea opdshelf en Settings › Apps and connections. Si tu opdshelf aún no tiene llaves, usa el usuario y la contraseña.')}
          </div>
        </div>
        <div className="set-control">
          <input className="field" type="password" value={key} placeholder={c?.hasKey ? '••••••' : 'opds_…'} aria-label={t('Llave de API')} onChange={(e) => setKey(e.target.value)} />
          {c?.hasKey && (
            <button className="settings-reset meta" onClick={forgetKey}>
              {t('Quitar')}
            </button>
          )}
        </div>
      </div>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Usuario y contraseña')}</div>
          <div className="set-hint">{t('Los de opdshelf (ADMIN_USERNAME y ADMIN_PASSWORD). Déjalos vacíos si tu opdshelf no pide contraseña.')}</div>
        </div>
        <div className="set-control">
          <input className="field" value={username} placeholder={t('Usuario')} aria-label={t('Usuario')} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          <input className="field" type="password" value={password} placeholder={c?.hasPassword ? '••••••' : t('Contraseña')} aria-label={t('Contraseña')} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>

      {profiles.length > 1 && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Perfil')}</div>
            <div className="set-hint">{t('En el que se guardan los libros.')}</div>
          </div>
          <div className="set-control">
            <Combo className="set-combo" items={profiles.map((p) => ({ id: p.id, label: p.name }))} value={profileId ?? profiles[0]?.id ?? null} label={t('Perfil')} onChange={setProfileId} />
          </div>
        </div>
      )}

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{c ? t('Conexión') : t('Conectar')}</div>
          <div className="set-hint">
            {!c
              ? t('Aún no está conectado.')
              : status?.lastError
                ? <span className="cal-set-error">{t(status.lastError)}</span>
                : when
                  ? t('Última sincronización: %1 · %2 libros con subrayados').replace('%1', when).replace('%2', String(status?.books ?? 0))
                  : t('Conectado, aún sin sincronizar.')}
            {result && <div>{result}</div>}
            {error && <div className="cal-set-error">{error}</div>}
          </div>
        </div>
        <div className="set-control">
          <button className="set-button" disabled={!valid} onClick={save}>
            {t('Guardar')}
          </button>
          {c && (
            <button className="set-button" disabled={busy} onClick={() => sync(false)}>
              {busy ? t('Sincronizando…') : t('Sincronizar ahora')}
            </button>
          )}
        </div>
      </div>

      {c && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Volver a traer todo')}</div>
            <div className="set-hint">{t('Rehace las notas de todos los libros, también los que no han cambiado (por ejemplo, si borraste alguna).')}</div>
          </div>
          <div className="set-control">
            <button className="settings-reset meta" disabled={busy} onClick={() => sync(true)}>
              {t('Traer todo')}
            </button>
            <button className="settings-reset meta" onClick={remove}>
              {t('Quitar conexión')}
            </button>
          </div>
        </div>
      )}

      <div className="set-block">
        <div className="set-name">{t('Si también usas el plugin de Canvian en KOReader')}</div>
        <p className="set-hint">{t('Ya no hace falta: el plugin de opdshelf manda tus subrayados a opdshelf y Canvian los lee de ahí. Puedes quitarlo. Mientras siga instalado, no toca los libros que llegan desde opdshelf.')}</p>
      </div>
    </>
  );
}
