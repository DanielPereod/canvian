import { useEffect, useState } from 'react';
import { api, type ExtensionStatus } from './api';
import { CopyBox } from './AiSettings';
import { t } from './i18n';

// Configuración › Extensión del navegador: la extensión de Chrome (carpeta
// extension/ del repositorio) que recorta páginas a notas y enseña en Outlook
// las tareas de cada hilo. Se descarga ya configurada (dirección y llave).

export function ExtensionSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [showKey, setShowKey] = useState(false);

  const refresh = () => api.extensionStatus().then(setStatus);
  useEffect(() => {
    refresh().catch(() => setStatus({ token: null, publicUrl: null }));
  }, []);

  const base = status?.publicUrl || location.origin;
  const download = `/api/extension/download.zip?base=${encodeURIComponent(base)}`;

  const newKey = () => {
    if (status?.token && !window.confirm(t('La extensión dejará de funcionar hasta que pongas la llave nueva en sus opciones (o la vuelvas a descargar). ¿Crear otra?'))) return;
    report(api.createExtensionToken().then(refresh));
  };
  const revoke = () => {
    if (!window.confirm(t('La extensión dejará de poder guardar recortes y ver tareas. ¿Desactivar?'))) return;
    report(api.revokeExtensionToken().then(refresh));
  };

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Una extensión para Chrome (y Edge, Brave…). Recorta una página, o lo que tengas seleccionado, y la guarda como nota en la carpeta que elijas, como Obsidian Web Clipper. En Outlook en la web enseña las tareas de cada hilo de correo, con su estado, y deja crear otras o vincular las que ya tienes.')}
      </p>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Extensión')}</div>
          <div className="set-hint">{t('Ya lleva puestas la dirección ({url}) y la llave.', { url: base })}</div>
        </div>
        <div className="set-control">
          <a className="set-button" href={download} download="canvian-extension.zip" onClick={() => setTimeout(() => void refresh().catch(() => {}), 1500)}>
            {t('Descargar extensión')}
          </a>
        </div>
      </div>

      <div className="set-block">
        <div className="set-name">{t('Cómo instalarla')}</div>
        <ol className="set-hint kor-steps">
          <li>{t('Descomprime el .zip: sale la carpeta canvian-extension.')}</li>
          <li>{t('En Chrome abre chrome://extensions y enciende «Modo de desarrollador» (arriba a la derecha).')}</li>
          <li>{t('Pulsa «Cargar descomprimida» y elige la carpeta canvian-extension.')}</li>
          <li>{t('Fija el icono de Canvian en la barra. Para recortar, púlsalo (o Alt ⇧ C). En Outlook, abre un correo: abajo a la derecha sale «Tareas».')}</li>
        </ol>
      </div>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Llave')}</div>
          <div className="set-hint">
            {status === null
              ? '…'
              : status.token
                ? t('Quien la tenga puede crear notas y cambiar tus tareas. Si se filtra, crea otra y vuelve a descargar la extensión.')
                : t('Aún no hay ninguna: se crea al descargar la extensión.')}
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
