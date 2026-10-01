import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import type { Fetcher } from '../src/calendars.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//prueba//ES
BEGIN:VTIMEZONE
TZID:Europe/Madrid
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:fiesta
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
SUMMARY:Fiesta Nacional
END:VEVENT
BEGIN:VEVENT
UID:yoga
DTSTART;TZID=Europe/Madrid:20260901T190000
DTEND;TZID=Europe/Madrid:20260901T200000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Europe/Madrid:20261013T190000
SUMMARY:Yoga
LOCATION:Gimnasio
END:VEVENT
BEGIN:VEVENT
UID:yoga
RECURRENCE-ID;TZID=Europe/Madrid:20261020T190000
DTSTART;TZID=Europe/Madrid:20261021T180000
DTEND;TZID=Europe/Madrid:20261021T190000
SUMMARY:Yoga (cambiado)
END:VEVENT
BEGIN:VEVENT
UID:anulado
DTSTART:20261015T100000Z
DTEND:20261015T110000Z
STATUS:CANCELLED
SUMMARY:Anulado
END:VEVENT
END:VCALENDAR
`;

let app: ReturnType<typeof createApp>;
let cookie = '';
let fetched: string[] = [];
let body = ICS;

const fetcher: Fetcher = async (url) => {
  fetched.push(url);
  return url.includes('roto') ? new Response('no', { status: 404 }) : new Response(body);
};

const call = async (method: string, path: string, data?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

const cal = (over: Record<string, unknown> = {}) => ({ id: 'c1', name: 'Casa', url: 'webcal://ejemplo.com/casa.ics', color: '#7cb8f2', on: true, ...over });

beforeEach(async () => {
  app = createApp(openDb(':memory:'), { fetchCalendar: fetcher });
  fetched = [];
  body = ICS;
  cookie = '';
  const res = await call('POST', '/api/auth/setup', { password: 'una-clave-larga' });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

describe('external calendars', () => {
  it('validates the calendars pref', async () => {
    expect((await call('PUT', '/api/prefs/calendars', [cal()])).status).toBe(204);
    expect((await call('PUT', '/api/prefs/calendars', [cal({ url: 'file:///etc/passwd' })])).status).toBe(400);
    expect((await call('PUT', '/api/prefs/calendars', [cal({ color: 'rojo' })])).status).toBe(400);
  });

  it('returns the events of a period, with repeats, exceptions and cancellations', async () => {
    await call('PUT', '/api/prefs/calendars', [cal()]);
    const res = await call('GET', '/api/calendars/events?from=2026-10-01&to=2026-11-01');
    expect(res.status).toBe(200);
    const { events, errors } = await res.json();
    expect(errors).toEqual({});
    expect(fetched).toEqual(['https://ejemplo.com/casa.ics']);
    const titles = events.map((e: { title: string }) => e.title);
    expect(titles).not.toContain('Anulado');
    expect(events.find((e: { title: string }) => e.title === 'Fiesta Nacional')).toMatchObject({ cal: 'c1', allDay: true, start: '2026-10-12', end: '2026-10-13' });
    const yoga = events.filter((e: { title: string }) => e.title.startsWith('Yoga'));
    // Martes 6, 13 (quitado), 20 (movido al miércoles 21) y 27 de octubre, ya en horario de invierno.
    expect(yoga.map((e: { start: string }) => e.start)).toEqual(['2026-10-06T17:00:00.000Z', '2026-10-21T16:00:00.000Z', '2026-10-27T18:00:00.000Z']);
    expect(yoga[0]).toMatchObject({ location: 'Gimnasio', allDay: false, end: '2026-10-06T18:00:00.000Z' });
    expect(yoga[1].title).toBe('Yoga (cambiado)');
  });

  it('caches the feed, skips calendars that are off and reports broken ones', async () => {
    await call('PUT', '/api/prefs/calendars', [cal(), cal({ id: 'c2', url: 'https://ejemplo.com/roto.ics' }), cal({ id: 'c3', url: 'https://ejemplo.com/apagado.ics', on: false })]);
    const first = await (await call('GET', '/api/calendars/events?from=2026-10-01&to=2026-11-01')).json();
    expect(Object.keys(first.errors)).toEqual(['c2']);
    expect(fetched.sort()).toEqual(['https://ejemplo.com/casa.ics', 'https://ejemplo.com/roto.ics']);
    await call('GET', '/api/calendars/events?from=2026-11-01&to=2026-12-01');
    expect(fetched).toHaveLength(2);
    await call('GET', '/api/calendars/events?from=2026-11-01&to=2026-12-01&fresh=1');
    expect(fetched).toHaveLength(4);
  });

  it('rejects bad periods', async () => {
    expect((await call('GET', '/api/calendars/events?from=ayer&to=2026-11-01')).status).toBe(400);
    expect((await call('GET', '/api/calendars/events?from=2026-11-01&to=2026-10-01')).status).toBe(400);
  });
});
