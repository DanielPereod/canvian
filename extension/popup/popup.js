import { api, getConfig, setConfig } from '../lib/api.js';
import { refreshStyle, startStyle } from '../lib/style.js';

// El recortador: coge la página (o lo seleccionado) en Markdown, deja
// cambiar el título, la carpeta y las etiquetas, y lo guarda como nota.

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of ['form', 'done', 'setup']) $(s).hidden = s !== id;
};

let clip = null; // lo que devolvió la página
let mode = 'page';
let folders = [];
let folder = null; // id, o null = «Recortes»
let clipsName = 'Recortes';
let lastOpen = null;
let tab = null;

const folderKey = (profile) => `folder:${profile ?? 'default'}`;

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

// ── La carpeta ─────────────────────────────────────────────────────────

const folderPath = (f) => f.path.split(' > ');
function renderFolderLabel() {
  const f = folders.find((x) => x.id === folder);
  $('folder-label').textContent = f ? folderPath(f).join(' › ') : `${clipsName} (por defecto)`;
}
function renderFolderList() {
  const q = $('folder-q').value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const list = $('folder-list');
  list.textContent = '';
  const add = (id, parts, cls) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.classList.add('cx-option');
    li.dataset.id = id ?? '';
    li.setAttribute('aria-selected', String(id === folder));
    parts.forEach((p, i) => {
      if (i) {
        const s = document.createElement('span');
        s.className = 'sep';
        s.textContent = ' › ';
        li.append(s);
      }
      li.append(p);
    });
    li.addEventListener('click', () => pickFolder(id));
    list.append(li);
  };
  if (!q) add(null, [`${clipsName} (por defecto)`], 'def');
  const match = folders.filter((f) => !q || f.path.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes(q));
  for (const f of match.slice(0, 80)) add(f.id, folderPath(f));
}
async function pickFolder(id) {
  folder = id;
  $('folder-pop').hidden = true;
  renderFolderLabel();
  const { profile } = await getConfig();
  await chrome.storage.local.set({ [folderKey(profile)]: id });
}
async function loadFolders() {
  const { profile } = await getConfig();
  const res = await api('/folders');
  folders = res.folders;
  clipsName = res.clips;
  const saved = (await chrome.storage.local.get(folderKey(profile)))[folderKey(profile)];
  folder = folders.some((f) => f.id === saved) ? saved : null;
  renderFolderLabel();
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
      body: { parent: folder, title, markdown, url: /^https?:/.test(clip.url) ? clip.url : null, tags, properties },
    });
    await chrome.storage.local.set({ lastTags: $('tags').value });
    lastOpen = res.open;
    $('done-path').textContent = res.path.split(' > ').join(' › ');
    show('done');
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'cx-error';
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
  try {
    profiles = (await api('/profiles')).profiles;
  } catch (e) {
    $('setup-error').textContent = e.message;
    show('setup');
    return;
  }
  const sel = $('profile');
  for (const p of profiles) sel.append(new Option(p.name, p.id));
  sel.value = profiles.some((p) => p.id === cfg.profile) ? cfg.profile : profiles[0]?.id;
  sel.hidden = profiles.length < 2;
  if (!cfg.profile && profiles[0]) await setConfig({ profile: profiles[0].id });

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
  if (e.key === 'Escape' && !$('folder-pop').hidden) {
    e.preventDefault();
    $('folder-pop').hidden = true;
  }
});
$('folder-btn').addEventListener('click', () => {
  const pop = $('folder-pop');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) {
    $('folder-q').value = '';
    renderFolderList();
    $('folder-q').focus();
  }
});
$('folder-q').addEventListener('input', renderFolderList);
$('folder-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('folder-list').querySelector('li')?.click();
  }
});
$('profile').addEventListener('change', async (e) => {
  await setConfig({ profile: e.target.value });
  await Promise.all([loadFolders(), refreshStyle()]);
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
