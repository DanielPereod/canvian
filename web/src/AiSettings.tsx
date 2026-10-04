import { useEffect, useState } from 'react';
import { api } from './api';
import { t } from './i18n';

// Configuración › Asistentes IA: el enlace del servidor MCP de Canvian y la
// configuración, lista para copiar, de cada cliente (Claude, ChatGPT, Codex,
// OpenCode…). Con él pueden leer y escribir tus notas y tareas.

type Status = { enabled: boolean; fromEnv: boolean; token: string | null; publicUrl: string | null };

type Client = {
  id: string;
  name: string;
  /** Dónde se pone (ya traducido al pintarlo). */
  where: string;
  /** Lo que se copia, a partir del enlace (y de la base y la llave, para los que van por cabecera). */
  config: (link: string, base: string, token: string) => string;
};

const json = (v: unknown) => JSON.stringify(v, null, 2);

const CLIENTS: Client[] = [
  {
    id: 'claude',
    name: 'Claude',
    where: 'En claude.ai (o la app de escritorio): Configuración › Conectores › Añadir conector personalizado. Nombre: Canvian. Pega el enlace y deja vacíos los campos de OAuth. Desde ahí también sale en la app del móvil.',
    config: (link) => link,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    where: 'En la terminal:',
    config: (link) => `claude mcp add --transport http --scope user canvian ${link}`,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    where: 'En chatgpt.com: Configuración › Aplicaciones y conectores › Configuración avanzada › activa el modo desarrollador. Luego, Crear: nombre Canvian, pega el enlace y elige «Sin autenticación».',
    config: (link) => link,
  },
  {
    id: 'codex',
    name: 'Codex',
    where: 'En ~/.codex/config.toml:',
    config: (link) => `[mcp_servers.canvian]\nurl = "${link}"`,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    where: 'En opencode.json (o ~/.config/opencode/opencode.json para todos los proyectos):',
    config: (link) => json({ $schema: 'https://opencode.ai/config.json', mcp: { canvian: { type: 'remote', url: link, enabled: true } } }),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    where: 'En ~/.gemini/settings.json:',
    config: (link) => json({ mcpServers: { canvian: { httpUrl: link } } }),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    where: 'En ~/.cursor/mcp.json:',
    config: (link) => json({ mcpServers: { canvian: { url: link } } }),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    where: 'En .vscode/mcp.json (o en tu configuración de usuario con «MCP: Open User Configuration»):',
    config: (link) => json({ servers: { canvian: { type: 'http', url: link } } }),
  },
  {
    id: 'other',
    name: 'Otro',
    where: 'Cualquier cliente con MCP por HTTP (Streamable HTTP). Con el enlace basta; si el cliente deja poner cabeceras, también vale la dirección sin llave y esta cabecera:',
    config: (_link, base, token) => `URL: ${base}/mcp\nAuthorization: Bearer ${token}`,
  },
];

const LAST = 'canvian:ai-client';

function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);
  return (
    <div className="ai-code">
      <pre aria-label={label}>{text}</pre>
      <button
        className="set-button ai-copy"
        onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? t('Copiado') : t('Copiar')}
      </button>
    </div>
  );
}

export function AiSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [client, setClient] = useState(() => {
    try {
      return localStorage.getItem(LAST) ?? 'claude';
    } catch {
      return 'claude';
    }
  });

  useEffect(() => {
    api.mcpStatus().then(setStatus, () => setStatus({ enabled: false, fromEnv: false, token: null, publicUrl: null }));
  }, []);

  const pick = (id: string) => {
    setClient(id);
    try {
      localStorage.setItem(LAST, id);
    } catch {
      // Sin almacenamiento local, se recuerda solo mientras está abierto.
    }
  };
  const create = () => {
    if (status?.enabled && !window.confirm(t('El enlace de ahora dejará de funcionar. ¿Crear otro?'))) return;
    report(api.createMcpToken().then(() => api.mcpStatus().then(setStatus)));
  };
  const revoke = () => {
    if (!window.confirm(t('Los asistentes dejarán de poder entrar en tus notas. ¿Desactivar?'))) return;
    report(api.revokeMcpToken().then(() => api.mcpStatus().then(setStatus)));
  };
  const savePublic = (raw: string) => {
    const url = raw.trim().replace(/\/+$/, '');
    if ((url || null) === (status?.publicUrl ?? null)) return;
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) return;
    report(api.setMcpPublicUrl(url || null).then(setStatus));
  };

  const base = status?.publicUrl || location.origin;
  const token = status?.token ?? null;
  const link = token ? `${base}/mcp/${token}` : null;
  const local = !status?.publicUrl && (location.protocol !== 'https:' || /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname));
  const chosen = CLIENTS.find((c) => c.id === client) ?? CLIENTS[0];

  return (
    <>
      <p className="set-hint cal-set-intro">
        {t('Conecta Canvian con tu asistente (Claude, ChatGPT, Codex, OpenCode…) para que pueda buscar y leer tus notas, crear y editar notas, apuntar tareas y marcarlas como hechas, ordenar notas y resumir lo que has hecho. Usa el servidor MCP de Canvian.')}
      </p>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Enlace')}</div>
          <div className="set-hint">
            {status === null
              ? '…'
              : status.fromEnv
                ? t('La llave viene de la variable CANVIAN_MCP_TOKEN del servidor.')
                : token
                  ? t('Quien tenga el enlace puede leer y cambiar tus notas: no lo compartas. Si se filtra, crea otro y el anterior deja de funcionar.')
                  : status.enabled
                    ? t('Hay un enlace de antes que no se puede enseñar. Crea otro para ver la configuración.')
                    : t('Aún no hay ninguno.')}
          </div>
        </div>
        {status && !status.fromEnv && (
          <div className="set-control">
            <button className="set-button" onClick={create}>
              {status.enabled ? t('Crear otro') : t('Crear enlace')}
            </button>
            {status.enabled && (
              <button className="settings-reset meta" onClick={revoke}>
                {t('Desactivar')}
              </button>
            )}
          </div>
        )}
      </div>

      {status && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Dirección pública')}</div>
            <div className="set-hint">
              {t('Con la que se llega a Canvian desde internet, con https. Los asistentes en la nube (claude.ai, ChatGPT) no pueden entrar en tu red local.')}
              {local && <span className="cal-set-error"> {t('Ahora usas una dirección local: pon aquí la pública.')}</span>}
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

      {link && token && (
        <div className="set-block">
          <div className="set-name">{t('Configuración')}</div>
          <div className="ai-clients" role="tablist" aria-label={t('Asistente')}>
            {CLIENTS.map((c) => (
              <button key={c.id} role="tab" aria-selected={c.id === chosen.id} className={c.id === chosen.id ? 'is-on' : ''} onClick={() => pick(c.id)}>
                {t(c.name)}
              </button>
            ))}
          </div>
          <div className="set-hint ai-where">{t(chosen.where)}</div>
          <CopyBox text={chosen.config(link, base, token)} label={chosen.name} />
        </div>
      )}
    </>
  );
}
