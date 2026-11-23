import { api, getConfig } from '../lib/api.js';
import { startStyle } from '../lib/style.js';

// El panel «Tareas» de Outlook. Es una página de la extensión dentro de un
// iframe (outlook.js lo pone): así lleva los estilos de tu Canvian sin
// chocar con los de Outlook y llama a Canvian directamente. outlook.js le
// dice qué hilo está abierto; el panel le dice qué tamaño necesita.

const OUTLOOK = /^https:\/\/(outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com|outlook\.cloud\.microsoft)$/;
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svg = (paths, size = 14, width = 1.8) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', width);
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
};
const ICON = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  unlink: ['M6 6l12 12M18 6L6 18'],
  block: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M5.6 5.6l12.8 12.8'],
  cal: ['M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M4 10h16M8 3v4M16 3v4'],
  flag: ['M5 21V4M5 4h11l-2 4 2 4H5'],
  note: ['M6 3h9l4 4v14H6z', 'M15 3v4h4'],
};

let parentOrigin = null;
let current = null; // { thread, subject, url }
let tasks = [];
let today = new Date().toISOString().slice(0, 10);
let open = false;
let folders = null;
let loadSeq = 0;

// ── Con Outlook (la página de fuera) ─────────────────────────────────

// Con el tono (claro u oscuro) del panel: si no coincide con el del iframe,
// Chrome le pinta un fondo opaco.
const tell = (msg) => parentOrigin && parent.postMessage({ source: 'canvian-panel', tone: document.documentElement.dataset.tone ?? 'light', ...msg }, parentOrigin);
new MutationObserver(() => tell({ type: 'tone' })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-tone'] });
const sizeObserver = new ResizeObserver(() => {
  const r = $('#frame').getBoundingClientRect();
  tell({ type: 'size', width: Math.ceil(r.width), height: Math.ceil(r.height) });
});
sizeObserver.observe($('#frame'));

window.addEventListener('message', (e) => {
  if (e.source !== parent || !OUTLOOK.test(e.origin) || e.data?.source !== 'canvian-outlook') return;
  parentOrigin = e.origin;
  if (e.data.type === 'thread') {
    const next = e.data.thread;
    const same = next?.thread === current?.thread && next?.subject === current?.subject;
    current = next;
    if (!same) {
      tasks = [];
      render();
      if (current) loadThread();
    }
    tell({ type: 'size', width: Math.ceil($('#frame').getBoundingClientRect().width), height: Math.ceil($('#frame').getBoundingClientRect().height) });
  }
  if (e.data.type === 'visible') loadThread();
  // El alto de la ventana de Outlook: hasta ahí puede crecer el panel.
  if (typeof e.data.height === 'number') document.documentElement.style.setProperty('--host-h', `${e.data.height}px`);
});

// ── Pintar ───────────────────────────────────────────────────────────

const STATUS = {
  todo: { label: 'Pendiente', next: 'doing' },
  doing: { label: 'En curso', next: 'done' },
  blocked: { label: 'Bloqueada', next: 'doing' },
  done: { label: 'Hecha', next: 'todo' },
};
const PRIO = { high: ['Alta', 'cp-p3'], medium: ['Media', 'cp-p2'], low: ['Baja', 'cp-p1'] };
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dayLabel = (d) => {
  if (!d) return null;
  const diff = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  const [y, m, dd] = d.split('-').map(Number);
  return `${dd} ${MONTHS[m - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
};
const pathText = (p) => (p ?? '').split(' > ').join(' › ');

function message(text) {
  const box = $('.cp-msg');
  box.hidden = !text;
  box.textContent = '';
  if (!text) return;
  box.append(text);
  if (/opciones|conectar|llave/i.test(text)) {
    const b = el('button', 'cx-quiet', 'Abrir opciones');
    b.type = 'button';
    b.addEventListener('click', () => chrome.runtime.openOptionsPage());
    box.append(b);
  }
}

function iconButton(icon, title, onClick, cls = '') {
  const b = el('button', `cx-quiet ${cls}`);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(svg(ICON[icon]));
  b.addEventListener('click', onClick);
  return b;
}

function taskRow(t, { linked }) {
  const li = el('li', `cp-task${t.status ? ` cp-${t.status}` : ''}${t.missing ? ' cp-missing' : ''}`);
  const body = el('div', 'cp-body');
  if (t.missing) {
    li.append(el('span', 'cp-st'));
    body.append(el('div', 'cp-txt', 'Esta tarea ya no está en su nota'));
    if (t.note) body.append(el('div', 'cp-meta', pathText(t.note.path)));
    li.append(body);
  } else {
    const st = el('button', 'cp-st');
    st.type = 'button';
    if (t.status === 'done') st.append(svg(ICON.check, 11, 3));
    const next = STATUS[t.status].next;
    st.title = linked ? `${STATUS[t.status].label} · marcar ${STATUS[next].label.toLowerCase()}` : STATUS[t.status].label;
    st.setAttribute('aria-label', st.title);
    if (linked) st.addEventListener('click', () => changeStatus(t, next));
    else st.disabled = true;
    body.append(el('div', 'cp-txt', t.text));
    const meta = el('div', 'cp-meta');
    const due = dayLabel(t.due);
    if (due) {
      const late = t.status !== 'done' && t.due < today;
      const chip = el('span', `cp-due${late ? ' cp-late' : t.due === today ? ' cp-today' : ''}`);
      chip.append(svg(ICON.cal, 11), due);
      meta.append(chip);
    }
    if (t.priority && PRIO[t.priority]) {
      const p = el('span', `cp-prio ${PRIO[t.priority][1]}`);
      p.append(svg(ICON.flag, 11), PRIO[t.priority][0]);
      meta.append(p);
    }
    if (t.status === 'doing' || t.status === 'blocked') meta.append(el('span', `cp-state cp-${t.status}`, STATUS[t.status].label));
    for (const tag of t.tags ?? []) meta.append(el('span', 'cp-tag', `#${tag}`));
    const path = el('span', 'cp-path');
    path.append(svg(ICON.note, 11), pathText(t.note.path));
    path.title = pathText(t.note.path);
    meta.append(path);
    body.append(meta);
    li.append(st, body);
  }
  const acts = el('div', 'cp-acts');
  if (linked) {
    if (!t.missing) {
      acts.append(
        iconButton('block', t.status === 'blocked' ? 'Desbloquear' : 'Marcar bloqueada', () => changeStatus(t, t.status === 'blocked' ? 'todo' : 'blocked')),
        iconButton('open', 'Abrir en Canvian', () => chrome.tabs.create({ url: t.open })),
      );
    }
    acts.append(iconButton('unlink', 'Desvincular del hilo (la tarea sigue en Canvian)', () => unlink(t)));
  } else {
    const pick = el('button', 'cx-quiet cp-pick', 'Vincular');
    pick.type = 'button';
    pick.addEventListener('click', () => linkTask(t));
    acts.append(pick);
  }
  li.append(acts);
  return li;
}

function render() {
  const has = !!current;
  const pending = tasks.filter((t) => !t.missing && t.status !== 'done').length;
  $('.cp-launch').hidden = !has || open;
  $('.cp-panel').hidden = !has || !open;
  $('.cp-count').textContent = tasks.length ? `${pending}/${tasks.length}` : '';
  $('.cp-count').hidden = !tasks.length;
  if (!has) return;
  $('.cp-subject').textContent = current.subject || 'Hilo sin asunto';
  $('.cp-subject').title = current.subject || '';
  const list = $('.cp-tasks');
  list.textContent = '';
  if (!tasks.length) list.append(el('li', 'cp-empty', 'Ninguna tarea vinculada a este hilo. Crea una abajo o vincula una que ya tengas en Canvian.'));
  // Primero lo que está en marcha; lo hecho, al final.
  const order = { doing: 0, blocked: 1, todo: 2, done: 3 };
  for (const t of [...tasks].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))) list.append(taskRow(t, { linked: true }));
}

const setOpen = (v) => {
  open = v;
  chrome.storage.local.set({ outlookOpen: v });
  render();
  if (v) {
    loadFolders();
    $('input.cp-text').focus();
  }
};

// ── Datos ────────────────────────────────────────────────────────────

async function loadThread() {
  const seq = ++loadSeq;
  if (!current) return render();
  try {
    const res = await api('/thread', { query: { thread: current.thread, subject: current.subject } });
    if (seq !== loadSeq) return;
    tasks = res.tasks;
    today = res.today;
    message(null);
  } catch (e) {
    if (seq !== loadSeq) return;
    tasks = [];
    message(e.message);
  }
  render();
}

async function loadFolders() {
  if (folders) return;
  try {
    folders = await api('/folders');
    const sel = $('select.cp-note');
    sel.textContent = '';
    sel.append(new Option(`${folders.inbox} (por defecto)`, ''));
    for (const f of folders.folders) sel.append(new Option(pathText(f.path), f.id));
    const { outlookNote } = await chrome.storage.local.get('outlookNote');
    if (outlookNote && folders.folders.some((f) => f.id === outlookNote)) sel.value = outlookNote;
  } catch {
    folders = null;
  }
}

const threadBody = () => ({ thread: current.thread, subject: current.subject, url: current.url });

async function changeStatus(t, status) {
  t.status = status;
  render();
  try {
    await api('/task', { method: 'PATCH', body: { task: t.id, status } });
  } catch (e) {
    message(e.message);
  }
  loadThread();
}

async function unlink(t) {
  tasks = tasks.filter((x) => x !== t);
  render();
  try {
    await api(`/link/${t.linkId}`, { method: 'DELETE' });
  } catch (e) {
    message(e.message);
  }
  loadThread();
}

async function linkTask(t) {
  try {
    const res = await api('/thread/link', { method: 'POST', body: { ...threadBody(), task: t.id } });
    tasks = res.tasks;
    $('.cp-search').hidden = true;
    $('.cp-q').value = '';
    message(null);
    render();
  } catch (e) {
    message(e.message);
  }
}

$('.cp-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input.cp-text').value.trim();
  if (!text || !current) return;
  const btn = $('.cp-add-btn');
  btn.disabled = true;
  try {
    const note = $('select.cp-note').value || null;
    const res = await api('/thread/task', {
      method: 'POST',
      body: { ...threadBody(), text, due: $('input.cp-due').value || null, priority: $('select.cp-prio').value, note },
    });
    chrome.storage.local.set({ outlookNote: note });
    tasks = res.tasks;
    $('input.cp-text').value = '';
    $('input.cp-due').value = '';
    $('select.cp-prio').value = 'none';
    message(null);
    render();
  } catch (err) {
    message(err.message);
  } finally {
    btn.disabled = false;
  }
});

let searchTimer = 0;
async function search() {
  const list = $('.cp-results');
  try {
    const res = await api('/tasks', { query: { q: $('.cp-q').value, limit: 12 } });
    const linked = new Set(tasks.map((t) => t.id));
    list.textContent = '';
    const found = res.tasks.filter((t) => !linked.has(t.id));
    if (!found.length) list.append(el('li', 'cp-empty', 'Nada que vincular con eso.'));
    for (const t of found) list.append(taskRow(t, { linked: false }));
  } catch (e) {
    message(e.message);
  }
}
$('.cp-toggle-link').addEventListener('click', () => {
  const box = $('.cp-search');
  box.hidden = !box.hidden;
  if (!box.hidden) {
    $('.cp-q').focus();
    search();
  }
});
$('.cp-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 200);
});
$('.cp-launch').addEventListener('click', () => setOpen(true));
$('.cp-x').addEventListener('click', () => setOpen(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && open && setOpen(false));

(async () => {
  startStyle();
  open = !!(await chrome.storage.local.get('outlookOpen')).outlookOpen;
  if (!(await getConfig()).token) message('Falta conectar la extensión con tu Canvian (abre las opciones).');
  render();
  // Aún sin saber quién es la página de fuera: «listo» no lleva datos.
  parent.postMessage({ source: 'canvian-panel', type: 'ready' }, '*');
})();
