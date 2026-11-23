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
      const shown = w > 0 && h > 0 && !!current;
      frame.style.visibility = shown ? 'visible' : 'hidden';
      frame.style.pointerEvents = shown ? 'auto' : 'none';
    }
  });

  // Outlook cambia de correo sin recargar: se mira cada poco.
  const tick = () => {
    const next = currentThread();
    if (next?.thread === current?.thread && next?.subject === current?.subject) return;
    current = next;
    if (!current) {
      frame.style.visibility = 'hidden';
      frame.style.pointerEvents = 'none';
    }
    sendThread();
  };
  setInterval(tick, 700);
  addEventListener('resize', () => send({ type: 'resize', height: innerHeight }));
  tick();
  // Al volver a la pestaña, por si se cambió algo en Canvian.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && send({ type: 'visible' }));
})();
