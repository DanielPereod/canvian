import { useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { Glyph } from './Wordmark';
import { t } from './i18n';

// Pantalla de entrada: la marca, una frase y el campo. Sin tarjeta ni
// adornos; toma los colores y la letra del tema, claro u oscuro.
export function AuthScreen({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-col">
        <div className="auth-brand">
          <Glyph className="auth-glyph" />
          <span>Canvian</span>
        </div>
        <div className="auth-copy">
          <h1 className="auth-title">{title}</h1>
          <p className="auth-hint">{hint}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

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
    <AuthScreen
      title={mode === 'setup' ? t('Crea tu contraseña') : t('Entra en Canvian')}
      hint={
        mode === 'setup'
          ? t('Elige una contraseña. Es la única cuenta de esta instalación y empezarás con los perfiles Personal y Trabajo.')
          : t('Escribe tu contraseña para volver a tus notas.')
      }
    >
      <form className="auth-form" onSubmit={submit}>
        <input
          id="password"
          className="auth-field"
          type="password"
          autoFocus
          aria-label={t('Contraseña')}
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          placeholder={mode === 'setup' ? t('Al menos 8 caracteres') : t('Contraseña')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="auth-button" type="submit" disabled={busy || password.length === 0}>
          {mode === 'setup' ? t('Crear y entrar') : t('Entrar')}
        </button>
        <p className="auth-error" role="alert">
          {error}
        </p>
      </form>
    </AuthScreen>
  );
}
