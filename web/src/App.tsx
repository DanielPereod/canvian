import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AuthCard } from './AuthCard';
import { Workspace } from './Workspace';

type State = 'loading' | 'setup' | 'login' | 'ready' | 'offline';

export function App() {
  const [state, setState] = useState<State>('loading');

  const refresh = useCallback(() => {
    api
      .status()
      .then((s) => setState(!s.setupDone ? 'setup' : s.authenticated ? 'ready' : 'login'))
      .catch(() => setState('offline'));
  }, []);

  useEffect(refresh, [refresh]);

  if (state === 'loading') return <div className="backdrop" />;
  if (state === 'offline')
    return (
      <div className="backdrop center">
        <div className="glass card">
          <h1>No encuentro el servidor</h1>
          <p className="muted">Comprueba que el contenedor de Canvian está en marcha y recarga.</p>
        </div>
      </div>
    );
  if (state === 'setup' || state === 'login')
    return <AuthCard mode={state} onDone={() => setState('ready')} />;
  return <Workspace onSignedOut={() => setState('login')} />;
}
