// Canvian en Outlook (web): pone el panel «Tareas» (outlook/panel.html, una
// página de la extensión) en un iframe abajo a la derecha y le dice qué hilo
// está abierto. El hilo se reconoce por el id que Outlook pone en la
// dirección (/mail/…/id/<id>) y, por si una respuesta lleva otro, por el asunto.

(() => {
  if (window.top !== window || window.__canvianOutlook) return;
  window.__canvianOutlook = true;

  // El asunto: entre los encabezados del panel de lectura, el de letra más
  // grande (el del remitente también es un «heading», pero más pequeño). Se
  // descartan los que parecen una persona (llevan un correo o están dentro
  // del bloque del remitente).
  // El asunto va fuera del contenedor de la conversación, así que se busca
  // en todo el «main» (lo de fuera, la lista y la navegación, no cuenta).
  const PANE = [
    '[role="main"]',
    '#ConversationReadingPaneContainer',
    '[aria-label="Reading Pane"]',
    '[aria-label="Panel de lectura"]',
    '[data-app-section="ConversationContainer"]',
  ];
  const CANDIDATES = '[role="heading"], h1, h2, h3, [id*="ubject" i], [class*="ubject" i]';
  const PERSONISH = '[class*="ender" i], [class*="ersona" i], [aria-label*="From" i], [aria-label*="De:" i], [data-testid*="ersona" i]';
  function readSubject() {
    const pane = PANE.map((s) => document.querySelector(s)).find(Boolean);
    if (!pane) return null;
    let best = null;
    for (const node of pane.querySelectorAll(CANDIDATES)) {
      if (node.closest(PERSONISH)) continue;
      const text = (node.getAttribute('title') || node.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text || text.length > 300 || /@|^(de|from|para|to|cc):/i.test(text)) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const size = parseFloat(getComputedStyle(node).fontSize) || 0;
      // Más grande gana; a igualdad, el de más arriba.
      if (!best || size > best.size + 0.5 || (Math.abs(size - best.size) <= 0.5 && rect.top < best.top)) {
        best = { text, size, top: rect.top };
      }
    }
    return best ? best.text.slice(0, 400) : null;
  }
  function currentThread() {
    const path = decodeURIComponent(location.pathname);
    const m = /\/(?:id|read)\/([^/?#]+)/.exec(path) ?? /[?&]ItemID=([^&#]+)/i.exec(location.search);
    const subject = readSubject();
    if (!m && !subject) return null;
    return { thread: m ? m[1] : `asunto:${subject}`, subject, url: location.href };
  }

  // ── Distintivos en la bandeja de entrada ─────────────────────────────
  // Cada fila de la lista lleva el id de su conversación (data-convid, el
  // mismo que sale en la dirección al abrirla). Si tiene tareas vinculadas
  // (por id o por asunto), se le pone una ficha con cómo van, delante del asunto.

  let badges = []; // [{ ids, subjectKey, tone, label, tip }] (lo manda el panel)

  // Lo mismo que subjectKey() en el servidor.
  function subjectKey(subject) {
    let s = (subject ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const prefix = /^\s*(?:\[[^\]]{1,30}\]\s*)?(?:re|rv|fw|fwd|tr|aw|wg|sv|vs|res|enc|r)\s*(?:\[\d+\])?\s*:\s*/i;
    for (let i = 0; i < 10 && prefix.test(s); i++) s = s.replace(prefix, '');
    s = s.replace(/^\s*\[[^\]]{1,30}\]\s*/, '').replace(/\s+/g, ' ').trim();
    return s || null;
  }

  const TONES = {
    light: { late: '#c4314b', blocked: '#a86400', doing: '#0f6cbd', done: '#107c10', todo: '#616161' },
    dark: { late: '#ff8a80', blocked: '#f0b45a', doing: '#6cb8f6', done: '#8bd17c', todo: '#c8c8c8' },
  };
  const BADGE_CSS = `:host{all:initial;display:inline-flex;flex:none;align-self:center;margin:0 6px;vertical-align:middle}
    span{display:inline-flex;align-items:center;gap:4px;height:17px;padding:0 7px 0 6px;border-radius:999px;font:600 10.5px/1 'Segoe UI',system-ui,sans-serif;letter-spacing:.01em;white-space:nowrap;
      color:var(--c);background:color-mix(in srgb,var(--c) 13%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 32%,transparent)}
    i{width:6px;height:6px;border-radius:50%;background:var(--c);flex:none}
    span.done i{width:8px;height:8px;background:none;-webkit-mask:none;border-radius:0;position:relative}
    span.done i::after{content:'';position:absolute;left:1px;top:0;width:3px;height:6px;border:solid var(--c);border-width:0 1.6px 1.6px 0;transform:rotate(45deg)}`;

  // Claro u oscuro: por el color del texto de la fila.
  function isDark(node) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(node).color);
    return m ? 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3] > 150 : false;
  }

  // El asunto de la fila: el texto que, sin «RE:», es el del hilo; con
  // key === null, el del segundo renglón (el primero es el remitente).
  function subjectNode(row, key) {
    const leaves = [...row.querySelectorAll('span')].filter((n) => n.childElementCount === 0 && n.textContent.trim() && !n.closest('.canvian-badge'));
    if (key) {
      const hit = leaves.find((n) => subjectKey(n.textContent) === key);
      if (hit) return hit;
    }
    if (key !== null) return null;
    const lines = leaves
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.n.textContent.trim().length > 3)
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const first = lines[0]?.r.top;
    const second = lines.find((x) => x.r.top > first + 8)?.r.top;
    if (second === undefined) return null;
    // En el segundo renglón, el texto más ancho (la hora también está ahí).
    return lines.filter((x) => Math.abs(x.r.top - second) < 6).sort((a, b) => b.r.width - a.r.width)[0].n;
  }

  function badgeFor(row) {
    if (!badges.length) return null;
    const id = row.getAttribute('data-convid');
    const byId = id && badges.find((b) => b.ids.includes(id));
    if (byId) return byId;
    // Por el asunto: solo si alguna hoja de la fila lo lleva.
    return badges.find((b) => b.subjectKey && subjectNode(row, b.subjectKey)) ?? null;
  }

  function paintBadges() {
    const rows = document.querySelectorAll('[data-convid]');
    for (const row of rows) {
      const b = badgeFor(row);
      const had = row.querySelector(':scope .canvian-badge');
      const sig = b ? `${b.tone}|${b.label}|${b.tip}` : '';
      if (had && had.dataset.sig === sig && had.isConnected) continue;
      had?.remove();
      if (!b) continue;
      const host = document.createElement('span');
      host.className = 'canvian-badge';
      host.dataset.sig = sig;
      host.title = `Canvian · ${b.label}\n${b.tip}`;
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = BADGE_CSS;
      const pill = document.createElement('span');
      pill.className = b.tone;
      pill.style.setProperty('--c', TONES[isDark(row) ? 'dark' : 'light'][b.tone] ?? TONES.light.todo);
      pill.append(document.createElement('i'), b.label);
      root.append(style, pill);
      // Detrás del asunto (que se recorta él, no la ficha); si no se encuentra, al final de la fila.
      const subject = (b.subjectKey && subjectNode(row, b.subjectKey)) || subjectNode(row, null);
      if (subject?.parentElement) subject.parentElement.insertBefore(host, subject.nextSibling);
      else row.append(host);
    }
  }

  // Abrir un correo desde la vista general: su fila si está en la lista (sin
  // recargar Outlook); si no, su dirección.
  function go(url, ids) {
    const row = (ids ?? []).map((id) => document.querySelector(`[data-convid="${CSS.escape(id)}"]`)).find(Boolean);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      row.click();
      return;
    }
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/^outlook\.(office|office365|live|cloud)\.(com|microsoft)$/.test(u.hostname)) return;
      // En la misma Outlook en la que se está (office.com y cloud.microsoft son la misma).
      location.assign(`${location.origin}${u.pathname}${u.search}${u.hash}`);
    } catch {
      // Dirección rara: nada.
    }
  }

  const PANEL = chrome.runtime.getURL('outlook/panel.html');
  const ORIGIN = new URL(PANEL).origin;
  const frame = document.createElement('iframe');
  frame.src = PANEL;
  frame.title = 'Canvian · tareas del hilo';
  frame.setAttribute('allowtransparency', 'true');
  frame.style.cssText = [
    'position:fixed', 'right:6px', 'bottom:6px', 'z-index:2147483000',
    // Hasta saber cuánto mide, grande pero invisible (para que pueda medirse).
    'width:440px', 'height:200px', 'border:0', 'background:transparent', 'color-scheme:light',
    'visibility:hidden', 'pointer-events:none',
  ].join(';');
  document.documentElement.append(frame);

  let current;
  // Mientras el iframe aún está en blanco no se le puede escribir: se le
  // manda todo otra vez cuando avisa de que está listo.
  const send = (msg) => {
    try {
      frame.contentWindow?.postMessage({ source: 'canvian-outlook', ...msg }, ORIGIN);
    } catch {
      // Aún cargando.
    }
  };
  const sendThread = () => send({ type: 'thread', thread: current ?? null, height: innerHeight });

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.origin !== ORIGIN || e.data?.source !== 'canvian-panel') return;
    if (e.data.type === 'ready') sendThread();
    if (e.data.tone === 'dark' || e.data.tone === 'light') frame.style.colorScheme = e.data.tone;
    if (e.data.type === 'size') {
      const w = Math.min(e.data.width, innerWidth - 12);
      const h = Math.min(e.data.height, innerHeight - 12);
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
      const shown = w > 0 && h > 0 && e.data.shown !== false;
      frame.style.visibility = shown ? 'visible' : 'hidden';
      frame.style.pointerEvents = shown ? 'auto' : 'none';
    }
    if (e.data.type === 'badges') {
      badges = Array.isArray(e.data.threads) ? e.data.threads : [];
      paintBadges();
    }
    if (e.data.type === 'go' && typeof e.data.url === 'string') go(e.data.url, e.data.threads);
  });

  // Outlook cambia de correo sin recargar: se mira cada poco.
  const tick = () => {
    const next = currentThread();
    if (next?.thread === current?.thread && next?.subject === current?.subject) return;
    current = next;
    sendThread();
  };
  setInterval(() => {
    tick();
    paintBadges();
  }, 700);
  addEventListener('resize', () => send({ type: 'resize', height: innerHeight }));
  tick();
  // Al volver a la pestaña, por si se cambió algo en Canvian.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && send({ type: 'visible' }));
})();
