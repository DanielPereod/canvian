import { onLive } from '../live';

// Avisos de que algo cambió en las bases de datos: los de otros dispositivos
// llegan en vivo; los de esta pestaña (la vista de tablas, una mini app) se
// avisan aquí, para que los bloques ```db``` de las notas se pongan al día.

const local = new Set<() => void>();

export function dbTouched() {
  for (const l of local) l();
}

export function onDbChange(l: () => void) {
  local.add(l);
  const stop = onLive((scope) => scope === 'db' && l());
  return () => {
    local.delete(l);
    stop();
  };
}
