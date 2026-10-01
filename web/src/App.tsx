import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AuthCard } from './AuthCard';
import { Workspace } from './Workspace';
import { Styleguide } from './Styleguide';
import { t } from './i18n';

type State = 'loading' | 'setup' | 'login' | 'ready' | 'offline';

export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [state, setState] = useState<State>('loading');

  const refresh = useCallback(() => {
    api
      .status()
      .then((s) => setState(!s.setupDone ? 'setup' : s.authenticated ? 'ready' : 'login'))
      .catch(() => setState('offline'));
  }, []);

  useEffect(refresh, [refresh]);

  if (hash === '#sistema') return <Styleguide />;
  if (state === 'loading') return <div className="backdrop" />;
  if (state === 'offline')
    return (
      <div className="backdrop dotted center">
        <div className="surface-3 dialog">
          <h1 className="display">
            {t('Sin')} <em>{t('señal')}</em>
          </h1>
          <p className="muted">{t('No encuentro el servidor de Canvian. Comprueba que está en marcha y recarga la página.')}</p>
        </div>
      </div>
    );
  if (state === 'setup' || state === 'login')
    return <AuthCard mode={state} onDone={() => setState('ready')} />;
  return <Workspace onSignedOut={() => setState('login')} />;
}
