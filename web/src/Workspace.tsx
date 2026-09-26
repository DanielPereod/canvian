import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';

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

  if (!active) return <div className="backdrop" />;

  return (
    <div className="workspace" style={{ '--profile': active.color ?? 'var(--accent)' } as React.CSSProperties}>
      <ReactFlowProvider>
        <Canvas key={active.id} profile={active} />
      </ReactFlowProvider>

      <button className="glass profile-pill" onClick={() => setSwitcherOpen(true)}>
        <span className="dot" />
        {active.name}
      </button>

      <div className="hint">
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
