import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';

// Calendarios de fuera (Google, Outlook, Apple…) suscritos por su enlace iCal.
// La lista se guarda en el servidor como preferencia; el servidor descarga cada
// calendario, lo guarda un rato y da sus eventos de un periodo. Solo se leen.

export type ExternalCalendar = { id: string; name: string; url: string; color: string; on: boolean };

export type CalEvent = {
  cal: string;
  id: string;
  title: string;
  /** Día completo: «AAAA-MM-DD» (`end` es el día siguiente al último). Con hora: ISO. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
};

/** Colores para los calendarios, en orden: el siguiente libre para cada uno nuevo. */
export const CAL_COLORS = ['#7cb8f2', '#f0b45a', '#9dc88d', '#f28b82', '#b9a3f0', '#4fd1c5', '#e7a4c8', '#c9b28a'];

let current: ExternalCalendar[] = [];
// Cambia con cada edición: los eventos se vuelven a pedir.
let version = 0;
// La próxima petición se salta la caché del servidor (al pulsar «Actualizar»).
let freshNext = false;
const listeners = new Set<() => void>();

const clean = (v: unknown): ExternalCalendar[] =>
  Array.isArray(v)
    ? v.filter((c): c is ExternalCalendar => !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.url === 'string')
    : [];

function apply(next: ExternalCalendar[]) {
  current = next;
  version++;
  listeners.forEach((l) => l());
}

export function loadCalendars() {
  return api
    .prefs()
    .then((p) => {
      const next = clean(p.calendars);
      if (JSON.stringify(next) !== JSON.stringify(current)) apply(next);
    })
    .catch(() => {});
}

function save(next: ExternalCalendar[]) {
  const before = current;
  apply(next);
  const done = next.length ? api.savePref('calendars', next) : api.deletePref('calendars');
  return done.catch((e) => {
    apply(before);
    throw e;
  });
}

export function addCalendar(name: string, url: string) {
  const used = new Set(current.map((c) => c.color));
  const color = CAL_COLORS.find((c) => !used.has(c)) ?? CAL_COLORS[current.length % CAL_COLORS.length];
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return save([...current, { id, name: name.trim(), url: url.trim(), color, on: true }]);
}

export function updateCalendar(id: string, patch: Partial<Omit<ExternalCalendar, 'id'>>) {
  return save(current.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

export function removeCalendar(id: string) {
  return save(current.filter((c) => c.id !== id));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCalendars() {
  return useSyncExternalStore(subscribe, () => current);
}

// Cada cuánto se vuelven a pedir los eventos con el calendario a la vista.
const REFRESH = 15 * 60_000;

/**
 * Los eventos de los calendarios encendidos entre `from` y `to` (días, `to` sin
 * incluir), y los errores de los que no se han podido leer. Se piden de nuevo
 * cada 15 minutos y al cambiar la lista.
 */
export function useCalendarEvents(from: string, to: string, enabled = true) {
  const list = useCalendars();
  const v = useSyncExternalStore(subscribe, () => version);
  const [data, setData] = useState<{ events: CalEvent[]; errors: Record<string, string> }>({ events: [], errors: {} });
  const [tick, setTick] = useState(0);
  const any = list.some((c) => c.on);

  useEffect(() => {
    if (!enabled || !any) return;
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH);
    return () => clearInterval(timer);
  }, [enabled, any]);

  useEffect(() => {
    if (!enabled || !any) {
      setData({ events: [], errors: {} });
      return;
    }
    let alive = true;
    const fresh = freshNext;
    freshNext = false;
    api
      .calendarEvents(from, to, fresh)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [from, to, enabled, any, v, tick]);

  return data;
}

/** Vuelve a descargar ya los calendarios, sin esperar a los 15 minutos. */
export function refreshCalendars() {
  freshNext = true;
  version++;
  listeners.forEach((l) => l());
}
