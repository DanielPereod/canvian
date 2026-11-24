import { useEffect, useState } from 'react';
import { api, type ClaudeStatus } from './api';
import { t } from './i18n';

// Configuración › Asistentes IA › Claude con tu suscripción: la IA que enseña en
// los Cuadernos. Canvian usa Claude Code por detrás con tu cuenta de Claude
// (sin clave de API). Se conecta desde aquí: «Conectar» abre la página de
// Claude para iniciar sesión y luego se pega el código que da. Si la sesión
// caduca, se vuelve a conectar igual, sin tocar el contenedor.

const MODELS: { id: string; name: string }[] = [
  { id: '', name: 'El de tu cuenta (recomendado)' },
  { id: 'opus', name: 'Opus (el más capaz)' },
  { id: 'sonnet', name: 'Sonnet (más rápido)' },
  { id: 'haiku', name: 'Haiku (el más rápido)' },
];

export function ClaudeSettings({ report }: { report: (p: Promise<unknown>) => void }) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [login, setLogin] = useState<{ url: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    api.claudeStatus().then(setStatus, () => setStatus(null));
  }, []);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setOk(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const start = () =>
    run('login', async () => {
      const res = await api.claudeLogin();
      setLogin(res);
      setCode('');
      window.open(res.url, '_blank', 'noopener');
    });
  const send = () =>
    run('code', async () => {
      const st = await api.claudeLoginCode(code);
      setStatus(st);
      setLogin(null);
      setCode('');
      setOk(t('Conectado. Ya puede enseñarte en Cuadernos.'));
    });
  const cancel = () => {
    setLogin(null);
    report(api.claudeLoginCancel());
  };
  const saveToken = () =>
    run('token', async () => {
      setStatus(await api.claudeToken(token));
      setToken('');
      setPaste(false);
      setOk(t('Token guardado.'));
    });
  const test = () =>
    run('test', async () => {
      const res = await api.claudeTest();
      setStatus(res.status);
      setOk(t('Claude responde: todo bien.'));
    });
  const forget = () => {
    if (!window.confirm(t('Cuadernos dejará de poder usar a Claude hasta que lo vuelvas a conectar. ¿Desconectar?'))) return;
    report(api.claudeForget().then(() => api.claudeStatus().then(setStatus)));
  };

  return (
    <div className="set-block claude-set">
      <div className="set-name">{t('Claude con tu suscripción')}</div>
      <p className="set-hint">
        {t('La IA que te enseña en Cuadernos. Canvian usa Claude Code por detrás con tu cuenta de Claude (Pro o Max), sin clave de API: gasta los límites de tu suscripción, como cuando usas Claude.')}
      </p>

      <div className="set-row">
        <div className="set-info">
          <div className="set-name">{t('Estado')}</div>
          <div className="set-hint">
            {status === null
              ? '…'
              : status.connected
                ? t('Conectado ({hint}).', { hint: status.tokenHint ?? '' })
                : t('Sin conectar.')}
            {status?.lastError && <span className="cal-set-error"> {t('Último error: {error}', { error: status.lastError })}</span>}
          </div>
        </div>
        <div className="set-control">
          {status?.connected && (
            <button className="set-button" onClick={test} disabled={!!busy}>
              {busy === 'test' ? t('Probando…') : t('Probar')}
            </button>
          )}
          <button className="set-button" onClick={start} disabled={!!busy}>
            {busy === 'login' ? t('Abriendo…') : status?.connected ? t('Volver a conectar') : t('Conectar')}
          </button>
          {status?.connected && (
            <button className="settings-reset meta" onClick={forget}>
              {t('Desconectar')}
            </button>
          )}
        </div>
      </div>

      {login && (
        <div className="claude-login">
          <ol className="set-hint">
            <li>
              {t('Inicia sesión en la página de Claude que se acaba de abrir.')}{' '}
              <a href={login.url} target="_blank" rel="noreferrer">
                {t('¿No se ha abierto? Ábrela aquí')}
              </a>
            </li>
            <li>{t('Al terminar, Claude te enseña un código. Cópialo y pégalo aquí:')}</li>
          </ol>
          <div className="claude-login-row">
            <input
              className="field"
              value={code}
              autoFocus
              placeholder={t('Código de Claude')}
              aria-label={t('Código de Claude')}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && code.trim() && void send()}
            />
            <button className="btn btn-primary btn-sm" onClick={send} disabled={!code.trim() || !!busy}>
              {busy === 'code' ? t('Comprobando…') : t('Conectar')}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={cancel}>
              {t('Cancelar')}
            </button>
          </div>
        </div>
      )}

      {status && (
        <div className="set-row">
          <div className="set-info">
            <div className="set-name">{t('Modelo')}</div>
            <div className="set-hint">{t('Con cuál enseña. El de tu cuenta suele ir bien; uno más rápido responde antes.')}</div>
          </div>
          <div className="set-control">
            <select className="field" value={status.model} aria-label={t('Modelo')} onChange={(e) => report(api.claudeModel(e.target.value).then(setStatus))}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {t(m.name)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {paste ? (
        <div className="claude-login-row">
          <input className="field" value={token} placeholder="sk-ant-oat01-…" aria-label={t('Token de Claude Code')} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={saveToken} disabled={!token.trim() || !!busy}>
            {t('Guardar')}
          </button>
        </div>
      ) : (
        <button className="settings-reset meta claude-paste" onClick={() => setPaste(true)}>
          {t('¿Tienes ya un token de «claude setup-token»? Pégalo')}
        </button>
      )}

      {error && <p className="set-hint cal-set-error">{error}</p>}
      {ok && <p className="set-hint claude-ok">{ok}</p>}
    </div>
  );
}
