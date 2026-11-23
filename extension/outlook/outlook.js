// Canvian en Outlook (web): un panel con las tareas del hilo abierto.
// El hilo se reconoce por el id que Outlook pone en la dirección
// (/mail/…/id/<id>) y, por si una respuesta lleva otro, por su asunto.
// Las llamadas a Canvian las hace el service worker (background.js).

(() => {
  if (window.__canvianOutlook) return;
  window.__canvianOutlook = true;

  const call = (path, { method = 'GET', body, query } = {}) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'api', path, method, body, query }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error('La extensión se ha actualizado: recarga Outlook.'));
        if (res?.ok) resolve(res.data);
        else reject(Object.assign(new Error(res?.error ?? 'Error'), { status: res?.status ?? 0 }));
      });
    });

  // ── El hilo abierto ─────────────────────────────────────────────────

  const SUBJECT_SELECTORS = [
    '[data-app-section="ConversationContainer"] [role="heading"]',
    '#ConversationReadingPaneContainer [role="heading"]',
    '[role="main"] [role="heading"][aria-level="2"]',
    '[role="main"] .allowTextSelection[role="heading"]',
    '[aria-label="Reading Pane"] [role="heading"]',
    '[aria-label="Panel de lectura"] [role="heading"]',
    '[data-canvian-subject]',
  ];
  function currentThread() {
    const path = decodeURIComponent(location.pathname);
    const m = /\/(?:id|read)\/([^/?#]+)/.exec(path) ?? /[?&]ItemID=([^&#]+)/i.exec(location.search);
    let subject = null;
    for (const sel of SUBJECT_SELECTORS) {
      const el = document.querySelector(sel);
      const text = el?.getAttribute('title') || el?.textContent;
      if (text && text.trim()) {
        subject = text.trim().replace(/\s+/g, ' ').slice(0, 400);
        break;
      }
    }
    if (!m && !subject) return null;
    return { thread: m ? m[1] : `asunto:${subject}`, subject, url: location.href };
  }

  // ── El panel (en un shadow root, para que Outlook no lo pise) ───────

  const host = document.createElement('div');
  host.id = 'canvian-outlook';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="launch" part="launch" hidden><span class="dot"></span><span class="lbl">Tareas</span><span class="count"></span></button>
    <section class="panel" hidden>
      <header>
        <div class="head">
          <div class="kicker"><span class="dot"></span> Canvian · tareas del hilo</div>
          <div class="subject"></div>
        </div>
        <button class="x" title="Cerrar" aria-label="Cerrar">×</button>
      </header>
      <div class="msg" hidden></div>
      <ul class="tasks"></ul>
      <form class="add">
        <input class="text" placeholder="Nueva tarea para este hilo…" maxlength="1000" />
        <div class="row">
          <input class="due" type="date" title="Fecha" />
          <select class="prio" title="Prioridad">
            <option value="none">Prioridad</option>
            <option value="high">⏫ Alta</option>
            <option value="medium">🔼 Media</option>
            <option value="low">🔽 Baja</option>
          </select>
          <button class="primary" type="submit">Añadir</button>
        </div>
        <label class="where">En <select class="note"></select></label>
      </form>
      <div class="link">
        <button class="ghost toggle-link" type="button">Vincular una tarea que ya existe</button>
        <div class="search" hidden>
          <input class="q" placeholder="Buscar en tus tareas…" />
          <ul class="results"></ul>
        </div>
      </div>
    </section>`;
  document.documentElement.append(host);

  const $ = (sel) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  let current = null; // { thread, subject, url }
  let tasks = [];
  let today = new Date().toISOString().slice(0, 10);
  let open = false;
  let folders = null;
  let loadSeq = 0;

  chrome.storage.local.get('outlookOpen').then(({ outlookOpen }) => {
    open = !!outlookOpen;
    render();
  });
  const setOpen = (v) => {
    open = v;
    chrome.storage.local.set({ outlookOpen: v });
    render();
    if (v) $('.text').focus();
  };

  const STATUS = {
    todo: { icon: '○', label: 'Pendiente', next: 'doing' },
    doing: { icon: '◐', label: 'En curso', next: 'done' },
    blocked: { icon: '⊘', label: 'Bloqueada', next: 'doing' },
    done: { icon: '●', label: 'Hecha', next: 'todo' },
  };
  const PRIO = { high: '⏫', medium: '🔼', low: '🔽' };
  const dayLabel = (d) => {
    if (!d) return null;
    const diff = Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Mañana';
    if (diff === -1) return 'Ayer';
    const [y, m, dd] = d.split('-').map(Number);
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${dd} ${months[m - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
  };

  function message(text, kind = 'error') {
    const box = $('.msg');
    box.hidden = !text;
    box.className = `msg ${kind}`;
    box.textContent = '';
    if (!text) return;
    box.append(text);
    if (/opciones|conectar|llave/i.test(text)) {
      const b = el('button', 'ghost', 'Abrir opciones');
      b.type = 'button';
      b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'options' }));
      box.append(' ', b);
    }
  }

  function taskRow(t, { linked }) {
    const li = el('li', `task ${t.status ?? ''}${t.missing ? ' missing' : ''}`);
    if (t.missing) {
      li.append(el('span', 'st', '?'));
      const body = el('div', 'body');
      body.append(el('div', 'txt', 'Esta tarea ya no está en su nota'), el('div', 'meta', t.note?.path?.split(' > ').join(' › ') ?? ''));
      li.append(body);
    } else {
      const st = el('button', 'st', t.status === 'done' ? '✓' : '');
      st.title = `${STATUS[t.status].label} · clic: ${STATUS[STATUS[t.status].next].label.toLowerCase()}`;
      st.addEventListener('click', () => changeStatus(t, STATUS[t.status].next));
      if (!linked) st.disabled = true;
      const body = el('div', 'body');
      body.append(el('div', 'txt', t.text));
      const meta = el('div', 'meta');
      const due = dayLabel(t.due);
      if (due) meta.append(el('span', `due${t.status !== 'done' && t.due < today ? ' late' : t.due === today ? ' today' : ''}`, due));
      if (t.priority && PRIO[t.priority]) meta.append(el('span', 'prio', PRIO[t.priority]));
      for (const tag of t.tags ?? []) meta.append(el('span', 'tag', `#${tag}`));
      if (t.status === 'doing' || t.status === 'blocked') meta.append(el('span', `state ${t.status}`, STATUS[t.status].label));
      meta.append(el('span', 'path', t.note.path.split(' > ').join(' › ')));
      body.append(meta);
      li.append(st, body);
    }
    const acts = el('div', 'acts');
    if (linked) {
      if (!t.missing) {
        const more = el('button', 'ico', '⊘');
        more.title = t.status === 'blocked' ? 'Desbloquear' : 'Marcar bloqueada';
        more.addEventListener('click', () => changeStatus(t, t.status === 'blocked' ? 'todo' : 'blocked'));
        const go = el('button', 'ico', '↗');
        go.title = 'Abrir en Canvian';
        go.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open', url: t.open }));
        acts.append(more, go);
      }
      const un = el('button', 'ico', '×');
      un.title = 'Desvincular del hilo (la tarea sigue en Canvian)';
      un.addEventListener('click', () => unlink(t));
      acts.append(un);
    } else {
      const add = el('button', 'ghost pick', 'Vincular');
      add.addEventListener('click', () => linkTask(t));
      acts.append(add);
    }
    li.append(acts);
    return li;
  }

  function render() {
    const has = !!current;
    const pending = tasks.filter((t) => !t.missing && t.status !== 'done').length;
    $('.launch').hidden = !has || open;
    $('.panel').hidden = !has || !open;
    $('.count').textContent = tasks.length ? `${pending}/${tasks.length}` : '';
    $('.count').hidden = !tasks.length;
    if (!has) return;
    $('.subject').textContent = current.subject || 'Hilo sin asunto';
    $('.subject').title = current.subject || '';
    const list = $('.tasks');
    list.textContent = '';
    if (!tasks.length) list.append(el('li', 'empty', 'Ninguna tarea vinculada a este hilo. Crea una abajo o vincula una que ya tengas.'));
    // Primero lo pendiente; lo hecho, al final.
    const order = { doing: 0, blocked: 1, todo: 2, done: 3 };
    for (const t of [...tasks].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))) list.append(taskRow(t, { linked: true }));
  }

  async function loadThread() {
    const seq = ++loadSeq;
    if (!current) return render();
    try {
      const res = await call('/thread', { query: { thread: current.thread, subject: current.subject } });
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
      const res = await call('/folders');
      folders = res;
      const sel = $('.note');
      sel.textContent = '';
      sel.append(new Option(`${res.inbox} (por defecto)`, ''));
      for (const f of res.folders) sel.append(new Option(f.path.split(' > ').join(' › '), f.id));
      const { outlookNote } = await chrome.storage.local.get('outlookNote');
      if (outlookNote && res.folders.some((f) => f.id === outlookNote)) sel.value = outlookNote;
    } catch {
      folders = null;
    }
  }

  const threadBody = () => ({ thread: current.thread, subject: current.subject, url: current.url });

  async function changeStatus(t, status) {
    t.status = status;
    render();
    try {
      await call('/task', { method: 'PATCH', body: { task: t.id, status } });
    } catch (e) {
      message(e.message);
    }
    loadThread();
  }

  async function unlink(t) {
    tasks = tasks.filter((x) => x !== t);
    render();
    try {
      await call(`/link/${t.linkId}`, { method: 'DELETE' });
    } catch (e) {
      message(e.message);
    }
    loadThread();
  }

  async function linkTask(t) {
    try {
      const res = await call('/thread/link', { method: 'POST', body: { ...threadBody(), task: t.id } });
      tasks = res.tasks;
      $('.search').hidden = true;
      $('.q').value = '';
      message(null);
      render();
    } catch (e) {
      message(e.message);
    }
  }

  $('.add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('.text').value.trim();
    if (!text || !current) return;
    const btn = $('.add .primary');
    btn.disabled = true;
    try {
      const note = $('.note').value || null;
      const res = await call('/thread/task', {
        method: 'POST',
        body: { ...threadBody(), text, due: $('.due').value || null, priority: $('.prio').value, note },
      });
      chrome.storage.local.set({ outlookNote: note });
      tasks = res.tasks;
      $('.text').value = '';
      $('.due').value = '';
      $('.prio').value = 'none';
      message(null);
      render();
    } catch (err) {
      message(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  let searchTimer = 0;
  const search = async () => {
    const list = $('.results');
    try {
      const res = await call('/tasks', { query: { q: $('.q').value, limit: 12 } });
      const linked = new Set(tasks.map((t) => t.id));
      list.textContent = '';
      const found = res.tasks.filter((t) => !linked.has(t.id));
      if (!found.length) list.append(el('li', 'empty', 'Nada que vincular con eso.'));
      for (const t of found) list.append(taskRow(t, { linked: false }));
    } catch (e) {
      message(e.message);
    }
  };
  $('.toggle-link').addEventListener('click', () => {
    const box = $('.search');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      $('.q').focus();
      search();
    }
  });
  $('.q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
  });
  $('.launch').addEventListener('click', () => {
    setOpen(true);
    loadFolders();
  });
  $('.x').addEventListener('click', () => setOpen(false));
  // Que las teclas de Outlook (atajos de una letra) no salten escribiendo aquí.
  for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());

  // Outlook cambia de correo sin recargar: se mira cada poco.
  const sameThread = (a, b) => a?.thread === b?.thread && a?.subject === b?.subject;
  const tick = () => {
    const next = currentThread();
    if (sameThread(next, current)) return;
    current = next;
    tasks = [];
    render();
    if (current) {
      loadThread();
      if (open) loadFolders();
    }
  };
  setInterval(tick, 700);
  tick();
  // Al volver a la pestaña, por si se cambió algo en Canvian.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && loadThread());

  function CSS() {
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    :host {
      --bg: #fffdf9; --s2: #f3efe7; --line: #e4ded3; --line2: #cfc8ba; --text: #1d1b17; --t2: #5d5850; --t3: #8a847a;
      --accent: #0f8f84; --accent-soft: rgb(15 143 132 / 0.12); --ink: #fff; --late: #c2453b; --warn: #a4660c;
      font: 13px/1.4 'Segoe UI', 'Instrument Sans', system-ui, sans-serif; color: var(--text);
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #101317; --s2: #161a1f; --line: #22272e; --line2: #333942; --text: #eceef1; --t2: #a4aab3; --t3: #767d88;
        --accent: #4fd1c5; --accent-soft: rgb(79 209 197 / 0.14); --ink: #062320; --late: #f28b82; --warn: #f0b45a; }
    }
    button, input, select { font: inherit; color: inherit; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); display: inline-block; box-shadow: 0 0 8px var(--accent); flex: none; }
    .launch { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line2);
      background: var(--bg); box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); cursor: pointer; font-weight: 600; }
    .launch:hover { border-color: var(--accent); }
    .count { font-weight: 500; color: var(--t2); background: var(--s2); border-radius: 999px; padding: 0 7px; font-size: 12px; }
    .panel { width: 360px; max-height: min(620px, calc(100vh - 60px)); display: flex; flex-direction: column; background: var(--bg);
      border: 1px solid var(--line2); border-radius: 16px; box-shadow: 0 18px 50px rgb(0 0 0 / 0.25); overflow: hidden; }
    header { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
    .head { flex: 1; min-width: 0; }
    .kicker { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--t3); }
    .subject { margin-top: 3px; font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-size: 18px; line-height: 1.2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { border: 0; background: transparent; font-size: 20px; line-height: 1; color: var(--t3); cursor: pointer; padding: 2px 4px; border-radius: 6px; }
    .x:hover { color: var(--text); background: var(--s2); }
    .msg { margin: 10px 14px 0; padding: 8px 10px; border-radius: 10px; background: var(--s2); color: var(--late); font-size: 12px; }
    .msg .ghost { color: var(--accent); }
    ul { list-style: none; margin: 0; padding: 0; }
    .tasks { overflow: auto; padding: 6px 6px; flex: 1; min-height: 40px; }
    .task { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-radius: 10px; }
    .task:hover { background: var(--s2); }
    .st { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--t3); background: transparent;
      cursor: pointer; padding: 0; font-size: 11px; line-height: 15px; text-align: center; color: transparent; font-weight: 700; }
    .st:hover:not(:disabled) { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .st:disabled { cursor: default; }
    .task.doing .st { border-color: var(--accent); background: conic-gradient(var(--accent) 0 50%, transparent 50% 100%); }
    .task.blocked .st { border-color: var(--late); background: linear-gradient(135deg, transparent 44%, var(--late) 44% 56%, transparent 56%); }
    .task.done .st { border-color: var(--accent); background: var(--accent); color: var(--ink); }
    .task.missing .st { border-style: dashed; color: var(--t3); }
    .body { flex: 1; min-width: 0; }
    .txt { word-break: break-word; }
    .task.done .txt { text-decoration: line-through; color: var(--t3); }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 2px; font-size: 12px; color: var(--t3); }
    .meta .due { color: var(--t2); }
    .meta .due.today { color: var(--warn); font-weight: 600; }
    .meta .due.late { color: var(--late); font-weight: 600; }
    .meta .state.doing { color: var(--accent); }
    .meta .state.blocked { color: var(--late); }
    .meta .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .acts { display: flex; gap: 2px; opacity: 0; transition: opacity 120ms; }
    .task:hover .acts, .task:focus-within .acts, .results .acts { opacity: 1; }
    .ico { border: 0; background: transparent; color: var(--t3); cursor: pointer; width: 24px; height: 24px; border-radius: 6px; padding: 0; }
    .ico:hover { color: var(--text); background: var(--line); }
    .empty { padding: 14px 10px; color: var(--t3); text-align: center; }
    .add { border-top: 1px solid var(--line); padding: 10px 14px 8px; display: grid; gap: 6px; }
    input, select { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; outline: none; min-width: 0; }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .text, .q { width: 100%; }
    .row { display: flex; gap: 6px; min-width: 0; }
    .row .due { flex: 1 1 0; min-width: 0; }
    .row .prio { flex: 0 0 112px; }
    .row .primary { flex: none; }
    .primary { border: 1px solid var(--accent); background: var(--accent); color: var(--ink); font-weight: 600; border-radius: 999px; padding: 6px 14px; cursor: pointer; }
    .primary:disabled { opacity: 0.5; }
    .where { display: flex; align-items: center; gap: 6px; color: var(--t3); font-size: 12px; }
    .where select { flex: 1 1 0; min-width: 0; width: 100%; font-size: 12px; padding: 4px 6px; }
    .link { padding: 0 14px 12px; }
    .ghost { border: 0; background: transparent; color: var(--accent); cursor: pointer; padding: 2px 0; font-size: 12px; }
    .ghost:hover { text-decoration: underline; }
    .search { display: grid; gap: 6px; margin-top: 6px; }
    .results { max-height: 200px; overflow: auto; }
    .results .pick { padding: 2px 8px; }
    `;
  }
})();
