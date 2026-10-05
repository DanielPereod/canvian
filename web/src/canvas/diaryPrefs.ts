import { useSyncExternalStore } from 'react';
import { api } from '../api';

// En qué perfiles está el Diario: la lista de sus ids. Sin elegir, en ninguno.
// Se guarda en el servidor (igual en todos los dispositivos) y en este navegador.

type DiaryPrefs = { profiles: string[] };

const LOCAL = 'canvian:diary';
const DEFAULTS: DiaryPrefs = { profiles: [] };
let current: DiaryPrefs = DEFAULTS;
const listeners = new Set<() => void>();

const clean = (v: unknown): DiaryPrefs | null => {
  const list = v && typeof v === 'object' ? (v as DiaryPrefs).profiles : null;
  return Array.isArray(list) ? { profiles: list.filter((id): id is string => typeof id === 'string') } : null;
};

function apply(next: DiaryPrefs) {
  current = next;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(next));
  } catch {
    // Sin almacenamiento local llega igual desde el servidor.
  }
  listeners.forEach((l) => l());
}

try {
  const saved = clean(JSON.parse(localStorage.getItem(LOCAL) ?? 'null'));
  if (saved) current = saved;
} catch {
  // Sin almacenamiento local, los de fábrica.
}

export function loadDiaryPrefs() {
  return api
    .prefs()
    .then((p) => apply(clean(p.diary) ?? DEFAULTS))
    .catch(() => {});
}

export function setDiaryOn(profileId: string, on: boolean) {
  const before = current;
  const rest = current.profiles.filter((id) => id !== profileId);
  const next = { profiles: on ? [...rest, profileId] : rest };
  apply(next);
  return api.savePref('diary', next).catch((e) => {
    apply(before);
    throw e;
  });
}

export const diaryOn = (profileId: string) => current.profiles.includes(profileId);

export function useDiaryOn(profileId: string) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current.profiles.includes(profileId),
  );
}

export function useDiaryPrefs() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
