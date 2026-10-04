import { dateFmt } from './dates';
import { t, tn } from '../i18n';
import { parseRecur, type Recur, type RecurUnit } from './tasks';

// Las repeticiones de las tareas se escriben como en Obsidian Tasks («every
// week»), que es lo que queda en la nota; aquí se leen en el idioma de la interfaz.

const dayName = (d: number) => dateFmt({ weekday: 'short' }).format(new Date(2024, 0, 7 + d)).replace('.', '');

const UNIT: Record<RecurUnit, [string, string]> = {
  day: ['Cada día', 'Cada {n} días'],
  week: ['Cada semana', 'Cada {n} semanas'],
  month: ['Cada mes', 'Cada {n} meses'],
  year: ['Cada año', 'Cada {n} años'],
};

export function recurLabel(r: Recur): string {
  const weekdays = r.unit === 'week' && r.n === 1 && r.days.join() === '1,2,3,4,5';
  let out = weekdays ? t('Cada día laborable') : tn(r.n, UNIT[r.unit][0], UNIT[r.unit][1]);
  // Los días de la semana, de lunes a domingo.
  if (r.unit === 'week' && r.days.length && !weekdays) out += ` · ${[...r.days.filter((d) => d), ...r.days.filter((d) => !d)].map(dayName).join(', ')}`;
  if (r.unit === 'month' && r.monthDay !== null) out += ` · ${r.monthDay === -1 ? t('el último día') : t('el día {d}', { d: r.monthDay })}`;
  if (r.whenDone) out += ` · ${t('desde que se hace')}`;
  return out;
}

/** «Cada semana», o la regla tal cual si no se entiende. */
export const repeatLabel = (rule: string) => {
  const r = parseRecur(rule);
  return r ? recurLabel(r) : rule;
};
