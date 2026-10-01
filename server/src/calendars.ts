import ICAL from 'ical.js';

// Calendarios de fuera (Google, Outlook, Apple…) por su enlace iCal: el
// servidor los descarga, los guarda un rato y devuelve sus eventos de un
// periodo, con las repeticiones ya desplegadas. Solo se leen; nunca se escribe
// en ellos.

export type CalEvent = {
  /** Id del calendario (el de la preferencia `calendars`). */
  cal: string;
  /** Único dentro del calendario, también para cada repetición. */
  id: string;
  title: string;
  /** Día completo: «AAAA-MM-DD» (y `end` es el día siguiente al último). Con hora: ISO en UTC. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
};

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const TTL = 15 * 60_000;
const TIMEOUT = 15_000;
const MAX_BYTES = 10 * 1024 * 1024;
// Por si una regla se repite sin fin desde hace mucho (cada minuto, por ejemplo).
const MAX_STEPS = 20_000;

/** webcal:// es https:// con otro nombre; lo demás que no sea http(s) no vale. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

type Entry = { at: number; comp?: ICAL.Component; error?: string; loading?: Promise<void> };

export function createCalendarCache(fetcher: Fetcher = fetch) {
  const cache = new Map<string, Entry>();

  async function load(url: string, entry: Entry) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetcher(url, { signal: ctrl.signal, headers: { accept: 'text/calendar, */*' } });
      if (!res.ok) throw new Error('El servidor del calendario ha respondido con un error');
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('El calendario es demasiado grande');
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Ese enlace no es un calendario iCal');
      const comp = new ICAL.Component(ICAL.parse(text));
      for (const tz of comp.getAllSubcomponents('vtimezone')) {
        const id = tz.getFirstPropertyValue('tzid');
        if (typeof id === 'string' && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
      }
      entry.comp = comp;
      entry.error = undefined;
    } catch (e) {
      entry.error = ctrl.signal.aborted ? 'El calendario tarda demasiado en responder' : e instanceof Error ? e.message : 'No se ha podido leer el calendario';
    } finally {
      clearTimeout(timer);
      entry.at = Date.now();
    }
  }

  /** El calendario ya leído, o lo lee si no está o lleva más de 15 minutos guardado. */
  async function get(url: string, fresh = false): Promise<Entry> {
    let entry = cache.get(url);
    if (!entry) cache.set(url, (entry = { at: 0 }));
    if (entry.loading) await entry.loading;
    else if (fresh || Date.now() - entry.at > TTL) {
      entry.loading = load(url, entry).finally(() => (entry!.loading = undefined));
      await entry.loading;
    }
    return entry;
  }

  /** Olvida los que ya no se usan. */
  function keep(urls: string[]) {
    for (const k of cache.keys()) if (!urls.includes(k)) cache.delete(k);
  }

  return { get, keep };
}

const dayOf = (t: ICAL.Time) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;

/** Los eventos de `comp` que tocan [from, to), con cada repetición por separado. */
export function eventsBetween(comp: ICAL.Component, cal: string, from: Date, to: Date): CalEvent[] {
  const rangeStart = ICAL.Time.fromJSDate(from, true);
  const rangeEnd = ICAL.Time.fromJSDate(to, true);
  const vevents = comp.getAllSubcomponents('vevent');
  // Las excepciones (una repetición movida o cambiada) van con su evento.
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (!ev.uid) continue;
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else masters.set(`${ex.uid}#${ex.recurrenceId}`, ex);
  }

  const out: CalEvent[] = [];
  const push = (ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null, key: string) => {
    if (String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const allDay = start.isDate;
    // Sin final, un día entero dura ese día y uno con hora es un instante.
    const stop = end ? end : start.clone();
    if (!end && allDay) stop.adjust(1, 0, 0, 0);
    const instant = stop.compare(start) <= 0;
    if (instant ? start.compare(rangeStart) < 0 : stop.compare(rangeStart) <= 0) return;
    if (start.compare(rangeEnd) >= 0) return;
    out.push({
      cal,
      id: key,
      title: ev.summary?.trim() || '(sin título)',
      start: allDay ? dayOf(start) : start.toJSDate().toISOString(),
      end: allDay ? dayOf(stop) : stop.toJSDate().toISOString(),
      allDay,
      ...(ev.location ? { location: String(ev.location) } : {}),
    });
  };

  for (const [uid, ev] of masters) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate, uid);
      continue;
    }
    const it = ev.iterator();
    for (let steps = 0, next = it.next(); next && steps < MAX_STEPS; next = it.next(), steps++) {
      if (next.compare(rangeEnd) >= 0) break;
      const det = ev.getOccurrenceDetails(next);
      push(det.item, det.startDate, det.endDate, `${uid}@${next.toString()}`);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
