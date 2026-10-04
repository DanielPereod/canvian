import { useEffect, useState } from 'react';
import { api } from './api';
import { t } from './i18n';

// Configuración › Claude: el enlace del servidor MCP, para que Claude lea y
// escriba tus notas y tareas. La llave solo se ve al crearla (en el servidor
// se guarda su hash), así que el enlace se copia en ese momento.

export function ClaudeSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; fromEnv: boolean } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.mcpStatus().then(setStatus, () => setStatus({ enabled: false, fromEnv: false }));
  }, []);

  const create = () => {
    if (status?.enabled && !window.confirm(t('El enlace de ahora dejará de funcionar. ¿Crear otro?'))) return;
    const p = api.createMcpToken().then(({ token }) => {
      setLink(`${location.origin}/mcp/${token}`);
      setCopied(false);
      setStatus({ enabled: true, fromEnv: false });
    });
    report(p);
  };
  const revoke = () => {
    if (!window.confirm(t('Claude dejará de poder entrar en tus notas. ¿Desactivar?'))) return;
    report(api.revokeMcpToken().then(() => {
      setLink(null);
      setStatus({ enabled: false, fromEnv: false });
    }));
  };
  const copy = () => {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Conecta Canvian con Claude para que pueda buscar y leer tus notas, crear y editar notas, apuntar tareas y marcarlas como hechas, ordenar notas y resumir lo que has hecho. Usa el servidor MCP de Canvian.')}
      </p>

      {status?.fromEnv ? (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Enlace para Claude')}</div>
            <div className="set-hint">{t('La llave viene de la variable CANVIAN_MCP_TOKEN del servidor. El enlace es:')} <code>{location.origin}/mcp/…</code></div>
          </div>
        </div>
      ) : (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Enlace para Claude')}</div>
            <div className="set-hint">
              {status === null ? '…' : status.enabled ? t('Hay un enlace activo. Si lo has perdido, crea otro: el anterior deja de funcionar.') : t('Aún no hay ninguno.')}
            </div>
          </div>
          <div className="set-control">
            <button className="set-button" onClick={create} disabled={status === null}>
              {status?.enabled ? t('Crear otro') : t('Crear enlace')}
            </button>
            {status?.enabled && (
              <button className="settings-reset meta" onClick={revoke}>
                {t('Desactivar')}
              </button>
            )}
          </div>
        </div>
      )}

      {link && (
        <div className="set-block">
          <div className="set-name">{t('Tu enlace')}</div>
          <div className="set-hint">{t('Cópialo ahora: por seguridad no se vuelve a enseñar. Quien lo tenga puede leer y cambiar tus notas.')}</div>
          <div className="cal-set-fields">
            <input className="field cal-set-urlfield" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t('Tu enlace')} />
            <button className="set-button" onClick={copy}>
              {copied ? t('Copiado') : t('Copiar')}
            </button>
          </div>
        </div>
      )}

      <div className="set-block">
        <div className="set-name">{t('Cómo conectarlo')}</div>
        <div className="set-hint">
          {t('En claude.ai: Configuración › Conectores › Añadir conector personalizado. Ponle de nombre Canvian y pega el enlace. Claude tiene que poder llegar a tu servidor por internet con https: si abres Canvian por la red local, cambia el principio del enlace por tu dirección pública.')}
        </div>
        <div className="set-hint">
          {t('En Claude Code: claude mcp add --transport http canvian <enlace>')}
        </div>
      </div>
    </>
  );
}
