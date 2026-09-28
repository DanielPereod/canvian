import { CLIENT } from './api';

// Cambios hechos en otros dispositivos, avisados por el servidor al momento.
// Una sola conexión para toda la app; se abre con el primer interesado y el
// navegador la vuelve a abrir solo si se corta. Al reconectar se avisa de todo,
// por si algo cambió mientras no escuchábamos.

export type LiveScope = 'canvas' | 'prefs' | 'profiles';

const listeners = new Set<(scope: LiveScope) => void>();
let source: EventSource | null = null;
let seen = false;

const tell = (scope: LiveScope) => {
  for (const l of listeners) l(scope);
};

function open() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.addEventListener('hello', () => {
    if (seen) for (const s of ['canvas', 'prefs', 'profiles'] as const) tell(s);
    seen = true;
  });
  source.addEventListener('change', (e) => {
    try {
      const { scope, client } = JSON.parse((e as MessageEvent).data) as { scope: LiveScope; client: string | null };
      if (client !== CLIENT) tell(scope);
    } catch {
      // Un aviso ilegible no rompe nada: el siguiente lo arregla.
    }
  });
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
    }
  };
}
