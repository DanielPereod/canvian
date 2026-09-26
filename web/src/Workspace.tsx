import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';
import { Glyph } from './Wordmark';
import { Fireflies } from './Fireflies';

const ACTIVE_KEY = 'canvian.activeProfile';
const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readActive);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    api.profiles().then(setProfiles, () => onSignedOut());
  }, [onSignedOut]);

  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];

  const selectProfile = (id: string) => {
    setActiveId(id);
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      // Sin almacenamiento local simplemente no recordamos el perfil.
    }
    setSwitcherOpen(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // El color del perfil es el acento de toda la interfaz. Va en la raíz porque
  // los tokens derivados (--accent-soft, --glow-1…) se calculan ahí.
  useEffect(() => {
    if (active?.color) document.documentElement.style.setProperty('--accent', active.color);
  }, [active?.color]);

  if (!active) return <div className="backdrop" />;

  return (
    <div className="workspace backdrop">
      <Fireflies />
      <ReactFlowProvider>
        <Canvas key={active.id} profile={active} />
      </ReactFlowProvider>

      <div className="chrome-top-left">
        <button className="surface-2 pill" onClick={() => setSwitcherOpen(true)} title="Cambiar de perfil">
          <Glyph className="wordmark-glyph" />
          <span className="pill-name">{active.name}</span>
        </button>
      </div>

      <div className="hints">
        <span>
          <kbd>2×clic</kbd> nota
        </span>
        <span>
          <kbd>G</kbd> zona
        </span>
        <span>
          <kbd>{mod}</kbd>
          <kbd>K</kbd> buscar
        </span>
        <span>
          <kbd>{mod}</kbd>
          <kbd>⇧</kbd>
          <kbd>P</kbd> perfiles
        </span>
      </div>

      {switcherOpen && (
        <ProfileSwitcher
          profiles={profiles}
          activeId={active.id}
          onSelect={selectProfile}
          onCreate={async (name) => {
            const created = await api.createProfile(name);
            setProfiles((list) => [...list, created]);
            selectProfile(created.id);
          }}
          onSignOut={async () => {
            await api.logout();
            onSignedOut();
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
