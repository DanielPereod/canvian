import { api, getConfig } from './api.js';
import { FONT_STACKS } from './fonts.js';

// Viste las páginas de la extensión (popup, opciones y el panel de Outlook)
// como tu Canvian: carga su hoja de estilos (con todos los temas y letras),
// pone el tema que toca (claro u oscuro según el modo y el sistema), el color
// del perfil y las letras elegidas en Configuración › Aspecto. Lo último que
// se vio se guarda para pintar bien desde el primer momento.

const CACHE = 'styleCache';
const DARK = window.matchMedia('(prefers-color-scheme: dark)');
const DEFAULT = { appearance: { mode: 'auto', dark: 'minimo', light: 'minimo-claro' }, type: null, color: null, css: null };
const LIGHT_THEMES = new Set(['papel', 'bloques', 'piedras', 'minimo-claro', 'biblioteca', 'ateneo']);
let current = null;

// El tema de antes (uno solo): su tono pasa a ser el modo.
function appearanceOf(s) {
  if (s.appearance) return s.appearance;
  const t = s.legacyTheme;
  if (!t) return DEFAULT.appearance;
  return LIGHT_THEMES.has(t) ? { mode: 'light', dark: 'jardin', light: t } : { mode: 'dark', dark: t, light: 'papel' };
}

const stackOf = (id) => (id === 'ui' ? 'var(--font-ui)' : (FONT_STACKS[id] ?? null));
function setVar(style, name, value) {
  if (value) style.setProperty(name, value);
  else style.removeProperty(name);
}

function paint() {
  const s = current ?? DEFAULT;
  const root = document.documentElement;
  const a = appearanceOf(s);
  const tone = a.mode === 'auto' ? (DARK.matches ? 'dark' : 'light') : a.mode;
  const theme = tone === 'dark' ? a.dark : a.light;
  if (theme === 'jardin') delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.tone = tone;
  setVar(root.style, '--accent', s.color);
  setVar(root.style, '--profile', s.color);
  const t = s.type;
  setVar(root.style, '--font-ui', t ? stackOf(t.ui) : null);
  if (t?.size) root.style.setProperty('--type-scale', String(t.size / 14));
  if (document.body) {
    setVar(document.body.style, '--font-serif', t ? stackOf(t.titles) : null);
    setVar(document.body.style, '--title-font', t ? stackOf(t.titles) : null);
    setVar(document.body.style, '--read-font', t ? stackOf(t.text) : null);
    setVar(document.body.style, '--font-mono', t ? stackOf(t.code) : null);
  }
  // La hoja de Canvian; sin ella (sin conectar) valen los colores de lib/theme.css.
  let link = document.getElementById('canvian-css');
  if (s.css) {
    if (!link) {
      link = document.createElement('link');
      link.id = 'canvian-css';
      link.rel = 'stylesheet';
      link.addEventListener('load', () => root.classList.add('has-canvian'));
      link.addEventListener('error', () => root.classList.remove('has-canvian'));
      // Antes de los estilos propios, para que estos manden en lo suyo.
      document.head.prepend(link);
    }
    if (link.href !== s.css) link.href = s.css;
  } else if (link) {
    link.remove();
    root.classList.remove('has-canvian');
  }
}

// La hoja principal de la web (index-<hash>.css), leída de su index.html.
async function cssUrl(base) {
  const res = await fetch(`${base}/`, { cache: 'no-store' });
  const html = await res.text();
  const m = /<link[^>]+rel="stylesheet"[^>]*href="([^"]+\.css)"/i.exec(html) ?? /href="([^"]+\.css)"[^>]*rel="stylesheet"/i.exec(html);
  return m ? new URL(m[1], `${base}/`).href : null;
}

export async function refreshStyle() {
  const { url } = await getConfig();
  if (!url) return;
  try {
    const [look, css] = await Promise.all([api('/appearance'), cssUrl(url).catch(() => null)]);
    current = { ...look, css };
    await chrome.storage.local.set({ [CACHE]: current });
    paint();
  } catch {
    // Sin conexión: se queda lo último que se vio.
  }
}

export async function startStyle() {
  const saved = (await chrome.storage.local.get(CACHE))[CACHE];
  current = saved ?? null;
  paint();
  DARK.addEventListener('change', paint);
  await refreshStyle();
}
