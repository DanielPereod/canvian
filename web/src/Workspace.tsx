import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Viewport,
} from '@xyflow/react';
import { api, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';

const ACTIVE_KEY = 'canvian.activeProfile';

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function Canvas({ profile }: { profile: Profile }) {
  const flow = useReactFlow();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Cada perfil recuerda dónde lo dejaste.
  useEffect(() => {
    let cancelled = false;
    api.getViewport(profile.id).then((v) => {
      if (!cancelled) flow.setViewport(v, { duration: 250 });
    });
    return () => {
      cancelled = true;
    };
  }, [profile.id, flow]);

  const onMoveEnd = useCallback(
    (_: unknown, v: Viewport) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void api.saveViewport(profile.id, v), 400);
    },
    [profile.id],
  );

  return (
    <ReactFlow
      nodes={[]}
      edges={[]}
      onMoveEnd={onMoveEnd}
      minZoom={0.1}
      maxZoom={3}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--dots)" />
    </ReactFlow>
  );
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
        <Canvas profile={active} />
      </ReactFlowProvider>

      <button className="glass profile-pill" onClick={() => setSwitcherOpen(true)}>
        <span className="dot" />
        {active.name}
      </button>

      <div className="hint">
        <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>
        <kbd>⇧</kbd>
        <kbd>P</kbd> perfiles
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
