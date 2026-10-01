import { useState, type KeyboardEvent } from 'react';
import { ACTIONS, GROUPS, appliesIn, runAction, useKeymap, useView } from './keys';
import { Keys } from './Kbd';
import { MODES, THEMES, setMode, setTheme, useAppearance } from './theme';
import { LANGS, setLang, t, useLang } from './i18n';

// Paleta de comandos: los que sirven donde estás, agrupados, y además órdenes
// sin tecla (temas, modo, secciones de Configuración). Elegir uno lo ejecuta
// como si se hubiera pulsado su tecla, así cada vista lo atiende como siempre.

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const RECENT = 'canvian:recent-commands';
const readRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const remember = (key: string) => {
  try {
    localStorage.setItem(RECENT, JSON.stringify([key, ...readRecent().filter((k) => k !== key)].slice(0, 4)));
  } catch {
    // Sin almacenamiento local no hay recientes; nada más.
  }
};

// Abre Configuración en una sección (la recuerda Settings al abrirse).
const openSettingsAt = (section: string) => {
  try {
    localStorage.setItem('canvian:settings-section', section);
  } catch {
    // Se abre en la última que se usó.
  }
  runAction('settings');
};

type Entry = { key: string; label: string; hint?: string; group: string; combo?: string; run: () => void; on?: boolean };

export function ActionPalette({ onClose }: { onClose: () => void }) {
  const keymap = useKeymap();
  const view = useView();
  const { mode, dark, light } = useAppearance();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const entries: Entry[] = [
    ...ACTIONS.filter((a) => a.id !== 'commands' && appliesIn(a.ctx, view)).map((a) => ({
      key: a.id,
      label: a.label,
      hint: a.hint,
      group: a.group,
      combo: keymap[a.id],
      run: () => setTimeout(() => runAction(a.id), 0),
    })),
    ...MODES.map((m) => ({ key: `mode-${m.id}`, label: t('Modo {name}', { name: t(m.name).toLowerCase() }), hint: m.id === 'auto' ? t('Según el sistema') : undefined, group: 'Aspecto', run: () => void setMode(m.id).catch(() => {}), on: mode === m.id })),
    ...THEMES.map((th) => ({ key: `theme-${th.id}`, label: t(th.tone === 'dark' ? 'Tema: {name} (oscuro)' : 'Tema: {name} (claro)', { name: t(th.name) }), hint: t(th.hint), group: 'Aspecto', run: () => void setTheme(th.id).catch(() => {}), on: dark === th.id || light === th.id })),
    ...LANGS.map((l) => ({ key: `lang-${l.id}`, label: t('Idioma: {name}', { name: l.name }), hint: 'Language', group: 'Aspecto', run: () => void setLang(l.id).catch(() => {}), on: lang === l.id })),
    { key: 'set-aspecto', label: t('Configuración: Aspecto'), group: 'Aplicación', run: () => openSettingsAt('aspecto') },
    { key: 'set-atajos', label: t('Configuración: Atajos de teclado'), group: 'Aplicación', run: () => openSettingsAt('atajos') },
  ];

  // Sin escribir: recientes y luego por grupos. Escribiendo: por parecido.
  const q = norm(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  type Row = { entry: Entry; head?: string; id: string };
  let rows: Row[];
  if (!words.length) {
    const recent = readRecent()
      .map((k) => byKey.get(k))
      .filter((e): e is Entry => !!e);
    const order = [...GROUPS, 'Aspecto'] as string[];
    const grouped = order.flatMap((g) => entries.filter((e) => e.group === g).map((entry, i) => ({ entry, id: entry.key, head: i === 0 ? t(g) : undefined })));
    rows = [...recent.map((entry, i) => ({ entry, id: `r-${entry.key}`, head: i === 0 ? t('Recientes') : undefined })), ...grouped];
  } else {
    rows = entries
      .filter((e) => words.every((w) => norm(`${e.label} ${e.hint ?? ''} ${t(e.group)}`).includes(w)))
      .map((entry, i) => ({ entry, rank: (norm(entry.label).startsWith(q) ? 0 : words.every((w) => norm(entry.label).includes(w)) ? 1 : 2) * 100 + i }))
      .sort((x, y) => x.rank - y.rank)
      .map(({ entry }) => ({ entry, id: entry.key }));
  }
  const at = Math.min(cursor, Math.max(0, rows.length - 1));

  // Tras cerrar, para que la pulsación llegue a la vista y no a este campo.
  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    remember(entry.key);
    onClose();
    entry.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(Math.min(at + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(Math.max(at - 1, 0));
    } else if (e.key === 'Enter') run(rows[at]?.entry);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="surface-3 popover" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="field field-bare"
          autoFocus
          placeholder={t('Escribe un comando')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="popover-divider" />
        <ul className="list" role="listbox">
          {rows.map(({ entry: a, head, id }, i) => [
            head && (
              <li key={`h-${id}`} className="list-group" role="presentation">
                {head}
              </li>
            ),
            <li
              key={id}
              role="option"
              aria-selected={i === at}
              ref={i === at ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className="list-item"
              style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
              onMouseEnter={() => setCursor(i)}
              onClick={() => run(a)}
            >
              <span className="palette-label">
                {a.label}
                {a.hint && <span className="palette-hint">{a.hint}</span>}
              </span>
              <span className="trail">{a.combo ? <Keys combo={a.combo} /> : a.on ? <span className="meta">{t('Activo')}</span> : null}</span>
            </li>,
          ])}
          {!rows.length && <li className="list-item static">{t('Ningún comando se llama así')}</li>}
        </ul>
      </div>
    </div>
  );
}
