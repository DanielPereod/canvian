import { useSyncExternalStore } from 'react';
import { api } from './api';

// Letras de la interfaz, de los títulos, del texto y del código, y tamaño base.
// Cada una puede ser la del tema o una del catálogo, en cualquier tema. La de la
// interfaz y el tamaño van en la raíz (--font-ui, --type-scale), donde los
// temas derivan de ellas sus otras letras; las demás van en <body>
// (--font-serif y --title-font, --read-font, --font-mono), para que cambiar
// los títulos no arrastre al texto de los temas que leen en su serif.
// Se guarda en el servidor, y en este navegador para el primer fotograma.

export type FontKind = 'sans' | 'serif' | 'mono';
export type Font = { id: string; name: string; kind: FontKind; stack: string };

const SANS = 'ui-sans-serif, system-ui, sans-serif';
const SERIF = "'Iowan Old Style', Georgia, serif";
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const sans = (id: string, name: string, family = `${name} Variable`): Font => ({ id, name, kind: 'sans', stack: `'${family}', ${SANS}` });
const serif = (id: string, name: string, family = `${name} Variable`): Font => ({ id, name, kind: 'serif', stack: `'${family}', ${SERIF}` });
const mono = (id: string, name: string, family = `${name} Variable`): Font => ({ id, name, kind: 'mono', stack: `'${family}', ${MONO}` });

export const FONTS: Font[] = [
  sans('inter', 'Inter'),
  sans('instrument', 'Instrument Sans'),
  sans('geist', 'Geist'),
  sans('ibm-plex-sans', 'IBM Plex Sans'),
  sans('dm-sans', 'DM Sans'),
  sans('manrope', 'Manrope'),
  sans('figtree', 'Figtree'),
  sans('plus-jakarta', 'Plus Jakarta Sans'),
  sans('work-sans', 'Work Sans'),
  sans('source-sans', 'Source Sans 3'),
  sans('archivo', 'Archivo'),
  sans('space-grotesk', 'Space Grotesk'),
  sans('bricolage', 'Bricolage Grotesque'),
  sans('jost', 'Jost'),
  sans('outfit', 'Outfit'),
  sans('lexend', 'Lexend'),
  sans('nunito', 'Nunito'),
  sans('atkinson', 'Atkinson Hyperlegible', 'Atkinson Hyperlegible Next Variable'),
  { id: 'sistema', name: 'Sans del sistema', kind: 'sans', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },

  serif('newsreader', 'Newsreader'),
  serif('fraunces', 'Fraunces'),
  serif('instrument-serif', 'Instrument Serif', 'Instrument Serif'),
  serif('literata', 'Literata'),
  serif('source-serif', 'Source Serif 4'),
  serif('lora', 'Lora'),
  serif('merriweather', 'Merriweather'),
  serif('ibm-plex-serif', 'IBM Plex Serif', 'IBM Plex Serif'),
  serif('eb-garamond', 'EB Garamond'),
  serif('cormorant', 'Cormorant Garamond', 'Cormorant Garamond'),
  serif('crimson', 'Crimson Pro'),
  serif('libre-baskerville', 'Libre Baskerville', 'Libre Baskerville'),
  serif('playfair', 'Playfair Display'),
  serif('young-serif', 'Young Serif', 'Young Serif'),
  { id: 'serif-sistema', name: 'Serif del sistema', kind: 'serif', stack: "ui-serif, 'Iowan Old Style', Georgia, 'Times New Roman', serif" },

  mono('jetbrains-mono', 'JetBrains Mono'),
  mono('geist-mono', 'Geist Mono'),
  mono('ibm-plex-mono', 'IBM Plex Mono', 'IBM Plex Mono'),
  mono('fira-code', 'Fira Code'),
  mono('source-code-pro', 'Source Code Pro'),
  mono('roboto-mono', 'Roboto Mono'),
  mono('space-mono', 'Space Mono', 'Space Mono'),
  { id: 'mono-sistema', name: 'Mono del sistema', kind: 'mono', stack: MONO },
];

export const KINDS: { id: FontKind; name: string }[] = [
  { id: 'sans', name: 'Sans' },
  { id: 'serif', name: 'Serif' },
  { id: 'mono', name: 'Monoespaciadas' },
];

// La del tema activo, o (títulos y texto) la misma que la interfaz.
export const THEME = 'tema';
export const SAME_AS_UI = 'ui';

export type Slot = 'ui' | 'titles' | 'text' | 'code';
export type Typography = Record<Slot, string> & { size: number };

export const SLOTS: { id: Slot; name: string; hint: string; sameAsUi?: boolean }[] = [
  { id: 'ui', name: 'Letra de la interfaz', hint: 'Menús, listas, botones y la barra lateral.' },
  { id: 'titles', name: 'Letra de los títulos', hint: 'Títulos de notas, colecciones y portadas, y los acentos en cursiva.', sameAsUi: true },
  { id: 'text', name: 'Letra del texto', hint: 'El cuerpo de las notas al leerlas y los resúmenes de la biblioteca.', sameAsUi: true },
  { id: 'code', name: 'Letra del código', hint: 'Bloques de código, el Markdown en bruto y las etiquetas técnicas.' },
];

export const SIZES: { px: number; name: string }[] = [
  { px: 13, name: 'Pequeño' },
  { px: 14, name: 'Estándar' },
  { px: 15, name: 'Cómodo' },
  { px: 16, name: 'Grande' },
];

export const DEFAULT: Typography = { ui: THEME, titles: THEME, text: THEME, code: THEME, size: 14 };
const LOCAL = 'canvian:type';
let current = DEFAULT;
const listeners = new Set<() => void>();

const fontOf = (id: string) => FONTS.find((f) => f.id === id);
const valid = (slot: Slot, id: unknown): id is string =>
  id === THEME || (id === SAME_AS_UI && !!SLOTS.find((s) => s.id === slot)!.sameAsUi) || (typeof id === 'string' && !!fontOf(id));

// Antes solo se elegían la interfaz y los títulos, y solo valían en Biblioteca:
// sus valores de fábrica (Inter y Newsreader) pasan a ser «del tema».
function migrate(t: Record<string, unknown>) {
  if ('text' in t) return t;
  const titles = t.titles === 'serif' ? THEME : t.titles === 'sans' ? SAME_AS_UI : t.titles;
  return { ...t, ui: t.ui === 'inter' ? THEME : t.ui, titles, text: THEME, code: THEME };
}

function clean(v: unknown): Typography | null {
  if (!v || typeof v !== 'object') return null;
  const t = migrate(v as Record<string, unknown>);
  if (typeof t.size !== 'number' || t.size < 12 || t.size > 18) return null;
  const out = { size: Math.round(t.size) } as Typography;
  for (const s of SLOTS) out[s.id] = valid(s.id, t[s.id]) ? (t[s.id] as string) : THEME;
  return out;
}

function set(style: CSSStyleDeclaration, names: string[], value: string | null) {
  for (const n of names) {
    if (value) style.setProperty(n, value);
    else style.removeProperty(n);
  }
}

const stackOf = (id: string) => (id === SAME_AS_UI ? 'var(--font-ui)' : (fontOf(id)?.stack ?? null));

function apply(t: Typography) {
  current = t;
  const root = document.documentElement.style;
  set(root, ['--font-ui'], stackOf(t.ui));
  root.setProperty('--type-scale', String(t.size / 14));
  const body = document.body?.style;
  if (body) {
    set(body, ['--font-serif', '--title-font'], stackOf(t.titles));
    set(body, ['--read-font'], stackOf(t.text));
    set(body, ['--font-mono'], stackOf(t.code));
  }
  try {
    localStorage.setItem(LOCAL, JSON.stringify(t));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

export function startTypography() {
  try {
    const raw = localStorage.getItem(LOCAL);
    apply((raw && clean(JSON.parse(raw))) || DEFAULT);
  } catch {
    apply(DEFAULT);
  }
}

export function loadTypography() {
  return api
    .prefs()
    .then((p) => {
      const saved = clean(p.type);
      if (saved) apply(saved);
    })
    .catch(() => {});
}

export function setTypography(change: Partial<Typography>) {
  const before = current;
  const next = { ...current, ...change };
  apply(next);
  return api.savePref('type', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export function useTypography() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
