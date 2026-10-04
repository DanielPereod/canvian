// Tareas que se repiten, con la sintaxis de Obsidian Tasks: detrás del texto
// va «🔁 every week», y al hacerla se apunta otra igual con la fecha siguiente.
// Las reglas que se entienden:
//   every day · every 3 days · every weekday
//   every week · every 2 weeks · every week on Monday, Thursday · every monday
//   every month · every 2 months · every month on the 15th · every month on the last
//   every year · every 2 years
// y, con «when done» al final, se cuenta desde el día en que se hace, no desde
// la fecha que tenía.

export type RecurUnit = 'day' | 'week' | 'month' | 'year';
export type Recur = {
  n: number;
  unit: RecurUnit;
  /** Días de la semana (0 domingo … 6 sábado), solo con semanas. */
  days: number[];
  /** Día del mes (−1 el último), solo con meses. */
  monthDay: number | null;
  whenDone: boolean;
};

const WEEKDAY: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayList(s: string): number[] | null {
  const parts = s.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const d = WEEKDAY[p.replace(/s$/, '')] ?? WEEKDAY[p];
    if (d === undefined) return null;
    if (!out.includes(d)) out.push(d);
  }
  return out.length ? out.sort((a, b) => a - b) : null;
}

/** La regla escrita detrás de «🔁», o null si no se entiende. */
export function parseRecur(rule: string): Recur | null {
  let s = rule.toLowerCase().replace(/\s+/g, ' ').trim();
  const whenDone = / when done$/.test(s);
  if (whenDone) s = s.replace(/ when done$/, '');
  const m = /^every (?:(\d+|other) )?(.+)$/.exec(s);
  if (!m) return null;
  const n = m[1] === 'other' ? 2 : m[1] ? Number(m[1]) : 1;
  if (!(n >= 1 && n <= 999)) return null;
  const rest = m[2];
  const base = { n, days: [] as number[], monthDay: null as number | null, whenDone };
  if (/^days?$/.test(rest)) return { ...base, unit: 'day' };
  if (rest === 'weekday' && n === 1) return { ...base, unit: 'week', days: [1, 2, 3, 4, 5] };
  if (/^years?$/.test(rest)) return { ...base, unit: 'year' };
  let w = /^weeks?(?: on (.+))?$/.exec(rest);
  if (w) {
    const days = w[1] ? dayList(w[1]) : [];
    return days ? { ...base, unit: 'week', days } : null;
  }
  const mo = /^months?(?: on the (?:(\d{1,2})(?:st|nd|rd|th)?|(last)(?: day)?))?$/.exec(rest);
  if (mo) {
    const monthDay = mo[2] ? -1 : mo[1] ? Number(mo[1]) : null;
    if (monthDay !== null && monthDay !== -1 && (monthDay < 1 || monthDay > 31)) return null;
    return { ...base, unit: 'month', monthDay };
  }
  // «every monday», «every monday and friday»
  if (n === 1 && (w = /^(.+)$/.exec(rest))) {
    const days = dayList(w[1]);
    if (days) return { ...base, unit: 'week', days };
  }
  return null;
}

/** La regla escrita como la entiende Obsidian Tasks. */
export function recurText(r: Recur): string {
  const every = r.n > 1 ? `every ${r.n} ${r.unit}s` : `every ${r.unit}`;
  let out = every;
  if (r.unit === 'week' && r.days.length) {
    out = r.n === 1 && r.days.join() === '1,2,3,4,5' ? 'every weekday' : `${every} on ${r.days.map((d) => WEEKDAY_NAMES[d]).join(', ')}`;
  }
  if (r.unit === 'month' && r.monthDay !== null) out += r.monthDay === -1 ? ' on the last' : ` on the ${r.monthDay}${ordinal(r.monthDay)}`;
  return r.whenDone ? `${out} when done` : out;
}
const ordinal = (d: number) => (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');

// ── Fechas (AAAA-MM-DD, sin horas ni zonas) ─────────────────────────────
const DAY = 86_400_000;
const toDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) => toIso(new Date(toDate(iso).getTime() + n * DAY));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
// El día `day` (−1 el último) del mes `m` (puede pasarse de 11), sin salirse del mes.
const inMonth = (y: number, m: number, day: number) => {
  const first = new Date(Date.UTC(y, m, 1));
  const max = lastDay(first.getUTCFullYear(), first.getUTCMonth());
  return toIso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), day === -1 ? max : Math.min(day, max))));
};
const mondayOf = (iso: string) => plusDays(iso, -((toDate(iso).getUTCDay() + 6) % 7));

/** La siguiente fecha de la regla después de `from`. */
export function nextDate(r: Recur, from: string): string {
  const d = toDate(from);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (r.unit === 'day') return plusDays(from, r.n);
  if (r.unit === 'year') return inMonth(y + r.n, m, d.getUTCDate());
  if (r.unit === 'month') {
    if (r.monthDay === null) return inMonth(y, m + r.n, d.getUTCDate());
    const here = inMonth(y, m, r.monthDay);
    return here > from ? here : inMonth(y, m + r.n, r.monthDay);
  }
  if (!r.days.length) return plusDays(from, 7 * r.n);
  // Días de la semana: el siguiente de la lista, en las semanas que tocan
  // (la de `from` y luego cada `n`).
  const week0 = toDate(mondayOf(from)).getTime();
  for (let k = 1; k <= 7 * r.n + 7; k++) {
    const iso = plusDays(from, k);
    const week = Math.round((toDate(mondayOf(iso)).getTime() - week0) / (7 * DAY));
    if (week % r.n === 0 && r.days.includes(toDate(iso).getUTCDay())) return iso;
  }
  return plusDays(from, 7 * r.n);
}

/** La fecha de la siguiente vez, al hacer hoy una tarea con esta regla y esta fecha. */
export function nextDue(r: Recur, due: string | null, today: string): string {
  return nextDate(r, r.whenDone || !due ? today : due);
}

/** Las siguientes veces después de `from` y antes de `to` (como mucho `max`). */
export function occurrences(r: Recur, from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = nextDate(r, from); d < to && out.length < max; d = nextDate(r, d)) out.push(d);
  return out;
}
