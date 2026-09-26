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

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

export function dueLabel(date: string) {
  const n = daysUntil(date);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return fmt.format(new Date(y, m - 1, d)).replace(/[.,]/g, '');
}
