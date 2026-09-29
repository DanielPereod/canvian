import { useEffect, useState } from 'react';
import { onLive } from './live';
import { api, type BackgroundKind, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';
import { Ambient } from './backgrounds/Ambient';
import { BackgroundPicker } from './backgrounds/BackgroundPicker';
import { actionFor, keysBlocked, loadKeymap } from './keys';
import { loadTheme, toggleMode } from './theme';
import { Settings } from './Settings';
import { Help } from './Help';
import { ActionPalette } from './ActionPalette';

const ACTIVE_KEY = 'canvian.activeProfile';

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
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewBg, setPreviewBg] = useState<BackgroundKind | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    void loadKeymap();
    void loadTheme();
  }, []);

  useEffect(() => {
    api.profiles().then(setProfiles, () => onSignedOut());
  }, [onSignedOut]);

  // Lo que cambie en otro dispositivo (ajustes, perfiles) llega aquí también.
  useEffect(
    () =>
      onLive((scope) => {
        if (scope === 'prefs') {
          void loadKeymap();
          void loadTheme();
        } else if (scope === 'profiles') api.profiles().then(setProfiles, () => {});
      }),
    [],
  );

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
      if (keysBlocked()) return;
      const action = actionFor(e, ['commands', 'profiles', 'background', 'toggleMode', 'help', 'settings']);
      if (!action) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      // Escribiendo, solo valen las combinaciones con Ctrl/⌘ o Alt.
      if (typing && !(e.metaKey || e.ctrlKey || e.altKey)) return;
      e.preventDefault();
      if (action === 'commands') setCommandsOpen((open) => !open);
      else if (action === 'profiles') setSwitcherOpen((open) => !open);
      else if (action === 'background') setPickerOpen(true);
      else if (action === 'toggleMode') void toggleMode().catch(() => {});
      else if (action === 'help') setHelpOpen(true);
      else setSettingsOpen(true);
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

  const background = previewBg ?? active.background ?? 'plain';

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
    <div className="workspace backdrop">
      <Ambient kind={background} />
      <Canvas key={active.id} profile={active} shell={{ onProfiles: () => setSwitcherOpen(true), onSettings: () => setSettingsOpen(true) }} />

      {commandsOpen && <ActionPalette onClose={() => setCommandsOpen(false)} />}
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
          current={active.background ?? 'plain'}
          onPreview={setPreviewBg}
          onChoose={chooseBackground}
          onCancel={() => {
            setPickerOpen(false);
            setPreviewBg(null);
          }}
        />
      )}
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onBackground={() => {
            setSettingsOpen(false);
            setPickerOpen(true);
          }}
          onProfiles={() => {
            setSettingsOpen(false);
            setSwitcherOpen(true);
          }}
        />
      )}
      {helpOpen && (
        <Help
          onClose={() => setHelpOpen(false)}
          onSettings={() => {
            setHelpOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
    </div>
  );
}
