import { useEffect, useState } from 'react';
import { api, type BackgroundKind, type Profile } from './api';
import { ProfileSwitcher } from './ProfileSwitcher';
import { Canvas } from './canvas/Canvas';
import { Glyph } from './Wordmark';
import { Ambient } from './backgrounds/Ambient';
import { BackgroundPicker } from './backgrounds/BackgroundPicker';
import { Lab } from './lab/Lab';
import { EXPERIMENTS, useExperiments } from './lab/experiments';
import { actionFor, keysBlocked, loadKeymap, useKeymap } from './keys';
import { Keys } from './Kbd';
import { Settings } from './Settings';
import { Help } from './Help';

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewBg, setPreviewBg] = useState<BackgroundKind | null>(null);
  const [labOpen, setLabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const experiments = useExperiments();
  const keymap = useKeymap();

  useEffect(() => {
    void loadKeymap();
  }, []);

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
      if (keysBlocked()) return;
      const action = actionFor(e, ['profiles', 'background', 'lab', 'help', 'settings']);
      if (!action) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      // Escribiendo, solo valen las combinaciones con Ctrl/⌘ o Alt.
      if (typing && !(e.metaKey || e.ctrlKey || e.altKey)) return;
      e.preventDefault();
      if (action === 'profiles') setSwitcherOpen((open) => !open);
      else if (action === 'background') setPickerOpen(true);
      else if (action === 'lab') setLabOpen(true);
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
    <div className={`workspace backdrop ${EXPERIMENTS.filter((x) => experiments[x.id]).map((x) => `exp-${x.id}`).join(' ')}`}>
      <Ambient kind={background} />
      <Canvas key={active.id} profile={active} />

      <div className="chrome-top-left">
        <button className="surface-2 pill" onClick={() => setSwitcherOpen(true)} title="Cambiar de perfil">
          <Glyph className="wordmark-glyph" />
          <span className="pill-name">{active.name}</span>
        </button>
        <button className="surface-2 pill pill-icon" onClick={() => setSettingsOpen(true)} title="Configuración" aria-label="Configuración">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
        </button>
      </div>

      <button className="hints" onClick={() => setHelpOpen(true)} title="Ver todos los atajos">
        <Keys combo={keymap.help} /> atajos
      </button>

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
      {labOpen && <Lab onClose={() => setLabOpen(false)} />}
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onBackground={() => {
            setSettingsOpen(false);
            setPickerOpen(true);
          }}
          onLab={() => {
            setSettingsOpen(false);
            setLabOpen(true);
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
