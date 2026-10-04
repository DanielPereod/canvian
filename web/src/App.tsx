import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AuthCard, AuthScreen } from './AuthCard';
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
      <AuthScreen
        title={t('Sin conexión')}
        hint={t('No encuentro el servidor de Canvian. Comprueba que está en marcha y recarga la página.')}
      />
    );
  if (state === 'setup' || state === 'login')
    return <AuthCard mode={state} onDone={() => setState('ready')} />;
  return <Workspace onSignedOut={() => setState('login')} />;
}
