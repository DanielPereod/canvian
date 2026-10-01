import { locale, t } from '../i18n';

// Fechas de vencimiento: se guardan como AAAA-MM-DD y se leen en relativo.
const DAY = 86_400_000;

export function localToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function daysUntil(date: string) {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - localToday()) / DAY);
}

// Formatos de fecha en el idioma de la interfaz, creados al usarlos (uno por idioma y forma).
const fmts = new Map<string, Intl.DateTimeFormat>();
export function dateFmt(opts: Intl.DateTimeFormatOptions) {
  const key = `${locale()}\u0000${JSON.stringify(opts)}`;
  let f = fmts.get(key);
  if (!f) fmts.set(key, (f = new Intl.DateTimeFormat(locale(), opts)));
  return f;
}

export function dueLabel(date: string) {
  const n = daysUntil(date);
  if (n === 0) return t('Hoy');
  if (n === 1) return t('Mañana');
  if (n === -1) return t('Ayer');
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return dateFmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d)).replace(/[.,]/g, '');
}
