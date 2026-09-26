import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api';

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
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
      setBusy(false);
    }
  };

  return (
    <div className="backdrop center">
      <form className="glass card" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          Canvian
        </div>
        <h1>{mode === 'setup' ? 'Elige tu contraseña' : 'Hola de nuevo'}</h1>
        <p className="muted">
          {mode === 'setup'
            ? 'Es la única cuenta de esta instalación. Crearemos los perfiles Personal y Trabajo.'
            : 'Escribe tu contraseña para abrir el canvas.'}
        </p>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          placeholder={mode === 'setup' ? 'Al menos 8 caracteres' : 'Contraseña'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || password.length === 0}>
          {mode === 'setup' ? 'Crear y entrar' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
