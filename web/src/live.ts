import { CLIENT } from './api';

// Cambios hechos en otros dispositivos, avisados por el servidor al momento.
// Una sola conexión para toda la app; se abre con el primer interesado y el
// navegador la vuelve a abrir solo si se corta. Al reconectar, al volver a la
// pestaña (el móvil corta las conexiones en segundo plano) o si el canal lleva
// rato mudo (un proxy que lo retiene), se pide todo de nuevo por si acaso.

export type LiveScope = 'canvas' | 'prefs' | 'profiles';
const ALL = ['canvas', 'prefs', 'profiles'] as const;
// El servidor late cada 15 s; tres latidos perdidos es que el canal no llega.
const SILENCE = 45_000;
const CHECK = 10_000;

const listeners = new Set<(scope: LiveScope) => void>();
let source: EventSource | null = null;
let seen = false;
let heard = 0;
let watch: ReturnType<typeof setInterval> | undefined;

const tell = (scope: LiveScope) => {
  for (const l of listeners) l(scope);
};
const tellAll = () => ALL.forEach(tell);

function connect() {
  source?.close();
  source = new EventSource('/api/events');
  heard = Date.now();
  source.addEventListener('hello', () => {
    heard = Date.now();
    if (seen) tellAll();
    seen = true;
  });
  source.addEventListener('ping', () => {
    heard = Date.now();
  });
  source.addEventListener('change', (e) => {
    heard = Date.now();
    try {
      const { scope, client } = JSON.parse((e as MessageEvent).data) as { scope: LiveScope; client: string | null };
      if (client !== CLIENT) tell(scope);
    } catch {
      // Un aviso ilegible no rompe nada: el siguiente lo arregla.
    }
  });
}

const onVisible = () => {
  if (document.visibilityState !== 'visible') return;
  tellAll();
  if (Date.now() - heard > SILENCE) connect();
};

function open() {
  if (source || typeof EventSource === 'undefined') return;
  connect();
  document.addEventListener('visibilitychange', onVisible);
  // Si el canal se queda mudo, se pide todo y se vuelve a conectar.
  watch = setInterval(() => {
    if (document.visibilityState !== 'visible' || Date.now() - heard < SILENCE) return;
    tellAll();
    connect();
  }, CHECK);
}

export function onLive(l: (scope: LiveScope) => void) {
  listeners.add(l);
  open();
  return () => {
    listeners.delete(l);
    if (!listeners.size && source) {
      source.close();
      source = null;
      seen = false;
      clearInterval(watch);
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
