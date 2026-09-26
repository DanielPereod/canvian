import { useSyncExternalStore } from 'react';
import { api } from './api';

// Tema de la interfaz: solo cambia el aspecto (colores, letras, celdas del
// mapa). Se guarda en el servidor para todos los dispositivos, y en este
// navegador para pintarlo bien desde el primer fotograma.

export type ThemeId = 'jardin' | 'papel' | 'observatorio' | 'bloques' | 'piedras' | 'plano';

export const THEMES: { id: ThemeId; name: string; hint: string }[] = [
  { id: 'jardin', name: 'Jardín nocturno', hint: 'El de siempre: noche, luz del color del perfil' },
  { id: 'papel', name: 'Papel', hint: 'Claro, tinta sobre papel, como un cuaderno' },
  { id: 'observatorio', name: 'Observatorio', hint: 'Noche profunda, órbitas finas, letra clásica' },
  { id: 'bloques', name: 'Bloques', hint: 'Brutalista: negro, hueso y amarillo' },
  { id: 'piedras', name: 'Piedras de río', hint: 'Arena cálida y piedras de colores suaves' },
  { id: 'plano', name: 'Plano', hint: 'Papel de plano azul con líneas blancas' },
];

const LOCAL = 'canvian:theme';
const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);

let current: ThemeId = 'jardin';
const listeners = new Set<() => void>();

function apply(id: ThemeId) {
  current = id;
  if (id === 'jardin') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(LOCAL, id);
  } catch {
    // Sin almacenamiento local, el tema llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

// Antes de pintar: el último tema usado en este navegador.
export function startTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LOCAL);
  } catch {
    saved = null;
  }
  if (isTheme(saved)) apply(saved);
}

// Tras entrar: el que diga el servidor.
export function loadTheme() {
  return api
    .prefs()
    .then((p) => {
      if (isTheme(p.theme)) apply(p.theme);
    })
    .catch(() => {});
}

export function setTheme(id: ThemeId) {
  const before = current;
  apply(id);
  return api.savePref('theme', id).catch((e) => {
    apply(before);
    throw e;
  });
}

export function useTheme() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
