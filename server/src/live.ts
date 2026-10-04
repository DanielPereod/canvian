// Avisos en vivo: cada cambio guardado se anuncia a los demás dispositivos
// abiertos, que vuelven a pedir lo que haya cambiado. Solo se dice qué parte
// cambió (y quién lo cambió), nunca los datos: esos siguen yendo por la API.

export type LiveScope = 'canvas' | 'prefs' | 'profiles';
export type LiveEvent = { scope: LiveScope; client: string | null };

export function createHub() {
  const listeners = new Set<(e: LiveEvent) => void>();
  return {
    publish(e: LiveEvent) {
      for (const l of listeners) l(e);
    },
    listen(l: (e: LiveEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get size() {
      return listeners.size;
    },
  };
}

// Qué parte cambia con cada escritura; null si no le importa a nadie más
// (la sesión, la posición de la vista, subir un archivo).
export function scopeOf(method: string, path: string): LiveScope | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const p = path.replace(/^\/api/, '');
  if (p.startsWith('/auth') || p.startsWith('/media') || p.startsWith('/mcp') || p.startsWith('/koreader') || p.endsWith('/viewport')) return null;
  if (p.startsWith('/prefs')) return 'prefs';
  if (/^\/profiles(\/[^/]+)?$/.test(p)) return 'profiles';
  return 'canvas';
}
