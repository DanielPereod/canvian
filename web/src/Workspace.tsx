import { useEffect, useState } from 'react';
import { onLive } from './live';
import { api, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';
import { actionFor, comboOf, isBound, keysBlocked, loadKeymap } from './keys';
import { loadTheme, toggleMode } from './theme';
import { loadLang } from './i18n';
import { loadTypography } from './typography';
import { loadSidebarPrefs } from './canvas/sidebarPrefs';
import { loadWide } from './canvas/widePrefs';
import { loadCalendars } from './calendars';
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    void loadKeymap();
    void loadTheme();
    void loadLang();
    void loadTypography();
    void loadSidebarPrefs();
    void loadWide();
    void loadCalendars();
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
          void loadLang();
          void loadTypography();
          void loadSidebarPrefs();
          void loadWide();
          void loadCalendars();
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
      // Ctrl H era la tecla de la ayuda antes de «?»: sigue valiendo si está libre.
      const action = actionFor(e, ['commands', 'profiles', 'toggleMode', 'help', 'settings']) ?? (comboOf(e) === 'mod+h' && !isBound('mod+h') ? 'help' : null);
      if (!action) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      // Escribiendo, solo valen las combinaciones con Ctrl/⌘ o Alt.
      if (typing && !(e.metaKey || e.ctrlKey || e.altKey)) return;
      e.preventDefault();
      if (action === 'commands') setCommandsOpen((open) => !open);
      else if (action === 'profiles') setSwitcherOpen((open) => !open);
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

  return (
    <div className="workspace backdrop">
      <Canvas key={active.id} profile={active} shell={{ onProfiles: () => setSwitcherOpen(true), onSettings: () => setSettingsOpen(true), onCommands: () => setCommandsOpen(true) }} />

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
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
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
