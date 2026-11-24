import { api, getConfig, setConfig } from '../lib/api.js';
import { refreshStyle, startStyle } from '../lib/style.js';
import { combo, notePicker } from '../lib/controls.js';

// El recortador: coge la página (o lo seleccionado) en Markdown, deja
// cambiar el título, la carpeta y las etiquetas, y lo guarda como nota.

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ['form', 'done', 'setup']) $(s).hidden = s !== id;
};

let clip = null; // lo que devolvió la página
let mode = 'page';
let clipsName = 'Recortes';
let lastOpen = null;
let tab = null;

const folderKey = (profile) => `folder:${profile ?? 'default'}`;
let profileId = null; // el perfil en uso: el elegido o el abierto en Canvian

async function extract(wanted) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url ?? '')) {
    return { url: tab?.url ?? '', title: tab?.title ?? '', markdown: '', mode: 'link', hasSelection: false, site: '' };
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['vendor/Readability.js', 'vendor/turndown.js', 'vendor/turndown-plugin-gfm.js', 'content/clip.js'],
  });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (m) => window.__canvianClip(m), args: [wanted] });
  return result;
}

function setMode(next) {
  mode = next;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
}

function renderProps() {
  const box = $('props');
  box.textContent = '';
  const items = [
    ['Fuente', clip.site || (clip.url ? new URL(clip.url).hostname : '')],
    ['Autor', clip.author],
    ['Publicado', clip.published],
  ];
  for (const [name, value] of items) {
    if (!value) continue;
    const chip = document.createElement('span');
    chip.className = 'cx-chip';
    chip.title = name === 'Fuente' ? clip.url : value;
    const b = document.createElement('b');
    b.textContent = name;
    chip.append(b, ` ${value}`);
    box.append(chip);
  }
}

function renderCount() {
  const words = $('markdown').value.trim().split(/\s+/).filter(Boolean).length;
  $('count').textContent = words ? `${words} palabras` : '';
}

async function load(wanted) {
  $('status').textContent = 'Leyendo la página…';
  try {
    clip = await extract(wanted);
  } catch (e) {
    clip = { url: tab?.url ?? '', title: tab?.title ?? '', markdown: '', mode: 'link', hasSelection: false, site: '' };
    $('status').textContent = 'No se puede leer esta página; se guarda el enlace.';
  }
  setMode(clip.mode);
  document.querySelector('[data-mode="selection"]').disabled = !clip.hasSelection;
  $('title').value = clip.title ?? '';
  $('markdown').value = clip.markdown ?? '';
  renderProps();
  renderCount();
  if ($('status').textContent === 'Leyendo la página…') $('status').textContent = '';
}

// ── La carpeta: con el buscador de Canvian ─────────────────────────

const folderField = notePicker({
  search: async (q) => {
    const res = await api('/search', { query: { q, limit: 20 } });
    clipsName = res.clips ?? clipsName;
    return res;
  },
  defaultLabel: () => clipsName,
  placeholder: 'Buscar carpeta…',
  onChange: (v) => chrome.storage.local.set({ [folderKey(profileId)]: v }),
});
$('folder-slot').append(folderField.el);

// La carpeta elegida la última vez en este perfil (se guarda con su título).
async function loadFolders() {
  const key = folderKey(profileId);
  const saved = (await chrome.storage.local.get(key))[key];
  folderField.set(saved && typeof saved === 'object' && saved.id ? saved : null);
}

// ── Guardar ───────────────────────────────────────────────────────────

async function save() {
  const title = $('title').value.trim();
  if (!title) {
    $('title').focus();
    return;
  }
  $('save').disabled = true;
  $('status').textContent = 'Guardando…';
  $('status').className = 'cx-muted';
  const tags = $('tags')
    .value.split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);
  const properties = {};
  if (clip.author) properties.Autor = clip.author;
  if (clip.published && /^\d{4}-\d{2}-\d{2}$/.test(clip.published)) properties.Publicado = clip.published;
  let markdown = $('markdown').value;
  if (mode === 'link' && clip.url) markdown = `[${title}](${clip.url})${markdown ? `\n\n${markdown}` : ''}`;
  try {
    const res = await api('/clip', {
      method: 'POST',
      body: { parent: folderField.value?.id ?? null, title, markdown, url: /^https?:/.test(clip.url) ? clip.url : null, tags, properties },
    });
    await chrome.storage.local.set({ lastTags: $('tags').value });
    lastOpen = res.open;
    $('done-path').textContent = res.path.split(' > ').join(' › ');
    show('done');
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'cx-error';
    // La carpeta recordada ya no existe: vuelve a la de por defecto.
    if (/carpeta/i.test(e.message) && folderField.value) {
      folderField.set(null);
      chrome.storage.local.remove(folderKey(profileId));
    }
  } finally {
    $('save').disabled = false;
  }
}

// ── Arranque ──────────────────────────────────────────────────────────

async function start() {
  // ?tab=<id> abre el recortador sobre otra pestaña (para probarlo fuera del popup).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) {
    show('setup');
    return;
  }
  let profiles;
  let active;
  try {
    ({ profiles, active } = await api('/profiles'));
  } catch (e) {
    $('setup-error').textContent = e.message;
    show('setup');
    return;
  }
  const activeName = profiles.find((p) => p.id === active)?.name ?? '';
  const chosen = profiles.some((p) => p.id === cfg.profile) ? cfg.profile : '';
  const profileField = combo({
    label: 'Perfil',
    items: [{ id: '', label: `${activeName} · el de Canvian` }, ...profiles.map((p) => ({ id: p.id, label: p.name }))],
    value: chosen,
    onChange: async (v) => {
      await setConfig({ profile: v || null });
      profileId = v || (await api('/profiles')).active;
      await Promise.all([loadFolders(), refreshStyle()]);
    },
  });
  $('profile').append(profileField.el);
  $('profile').hidden = profiles.length < 2;
  profileId = chosen || active;

  const { lastTags } = await chrome.storage.local.get('lastTags');
  $('tags').value = lastTags ?? 'recorte';
  show('form');

  // Desde el menú contextual se pide un modo concreto.
  const { pendingClip } = await chrome.storage.session.get('pendingClip');
  await chrome.storage.session.remove('pendingClip');
  const pending = pendingClip && Date.now() - pendingClip.at < 15_000 ? pendingClip : null;
  const sel0 = pending?.mode ?? null;
  await Promise.all([loadFolders().catch((e) => ($('status').textContent = e.message)), load(sel0 ?? 'selection')]);
  if (pending?.mode === 'link' && pending.link) {
    clip = { ...clip, url: pending.link, title: pending.text || pending.link, markdown: '', mode: 'link' };
    $('title').value = clip.title;
    $('markdown').value = '';
    setMode('link');
    renderProps();
  }
  $('title').focus();
  $('title').select();
}

for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => !b.disabled && load(b.dataset.mode));
$('markdown').addEventListener('input', renderCount);
$('save').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setup-open').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open').addEventListener('click', () => lastOpen && chrome.tabs.create({ url: lastOpen }));
$('again').addEventListener('click', () => {
  show('form');
  load('selection');
});

startStyle();
start();
