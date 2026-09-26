import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api, type BackgroundKind, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';
import { Glyph } from './Wordmark';
import { Ambient } from './backgrounds/Ambient';
import { BackgroundPicker } from './backgrounds/BackgroundPicker';

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewBg, setPreviewBg] = useState<BackgroundKind | null>(null);

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
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setPickerOpen(true);
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

  const background = previewBg ?? active.background ?? 'dots';

  const chooseBackground = (kind: BackgroundKind) => {
    setPickerOpen(false);
    setPreviewBg(null);
    if (kind === active.background) return;
    setProfiles((list) => list.map((p) => (p.id === active.id ? { ...p, background: kind } : p)));
    api.updateProfile(active.id, { background: kind }).catch(() => {
      setProfiles((list) => list.map((p) => (p.id === active.id ? { ...p, background: active.background } : p)));
    });
  };

  return (
    <ReactFlowProvider>
    <div className="workspace backdrop">
      <Ambient kind={background} />
      <Canvas key={active.id} profile={active} background={background} />

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
          <kbd>B</kbd> fondo
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
      {pickerOpen && (
        <BackgroundPicker
          current={active.background ?? 'dots'}
          onPreview={setPreviewBg}
          onChoose={chooseBackground}
          onCancel={() => {
            setPickerOpen(false);
            setPreviewBg(null);
          }}
        />
      )}
    </div>
    </ReactFlowProvider>
  );
}
