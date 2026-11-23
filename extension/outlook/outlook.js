// Canvian en Outlook (web): pone el panel «Tareas» (outlook/panel.html, una
// página de la extensión) en un iframe abajo a la derecha y le dice qué hilo
// está abierto. El hilo se reconoce por el id que Outlook pone en la
// dirección (/mail/…/id/<id>) y, por si una respuesta lleva otro, por el asunto.

(() => {
  if (window.top !== window || window.__canvianOutlook) return;
  window.__canvianOutlook = true;

  const SUBJECT_SELECTORS = [
    '[data-app-section="ConversationContainer"] [role="heading"]',
    '#ConversationReadingPaneContainer [role="heading"]',
    '[role="main"] [role="heading"][aria-level="2"]',
    '[role="main"] .allowTextSelection[role="heading"]',
    '[aria-label="Reading Pane"] [role="heading"]',
    '[aria-label="Panel de lectura"] [role="heading"]',
  ];
  function currentThread() {
    const path = decodeURIComponent(location.pathname);
    const m = /\/(?:id|read)\/([^/?#]+)/.exec(path) ?? /[?&]ItemID=([^&#]+)/i.exec(location.search);
    let subject = null;
    for (const sel of SUBJECT_SELECTORS) {
      const node = document.querySelector(sel);
      const text = node?.getAttribute('title') || node?.textContent;
      if (text && text.trim()) {
        subject = text.trim().replace(/\s+/g, ' ').slice(0, 400);
        break;
      }
    }
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
