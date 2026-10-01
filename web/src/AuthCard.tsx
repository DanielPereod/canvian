import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import { Wordmark } from './Wordmark';
import { Fireflies } from './Fireflies';
import { t } from './i18n';

export function AuthCard({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (mode === 'setup' ? api.setup(password) : api.login(password));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('No se pudo conectar con el servidor'));
      setBusy(false);
    }
  };

  return (
    <div className="backdrop dotted center">
      <Fireflies />
      <form className="surface-3 dialog" onSubmit={submit}>
        <Wordmark className="auth-brand" />
        <div className="auth-copy">
          <h1 className="display">
            {mode === 'setup' ? (
              <>
                {t('Planta tu')} <em>{t('jardín')}</em>
              </>
            ) : (
              <>
                {t('Hola de')} <em>{t('nuevo')}</em>
              </>
            )}
          </h1>
          <p className="muted">
            {mode === 'setup'
              ? t('Elige una contraseña. Es la única cuenta de esta instalación y empezarás con los perfiles Personal y Trabajo.')
              : t('Escribe tu contraseña para volver a tus notas.')}
          </p>
        </div>
        <input
          id="password"
          className="field"
          type="password"
          autoFocus
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          placeholder={mode === 'setup' ? t('Al menos 8 caracteres') : t('Contraseña')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || password.length === 0}>
          {mode === 'setup' ? t('Crear y entrar') : t('Entrar')}
        </button>
      </form>
    </div>
  );
}
