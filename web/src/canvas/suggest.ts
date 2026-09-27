import type { NoteRow } from '../api';

// Sugerir una sección para una nota: las palabras de la nota contra el nombre
// de cada sección (pesa mucho) y contra lo que ya hay dentro (pesa según lo
// raro que sea la palabra). Sin nada claro, no sugiere.

const STOP = new Set(
  'a al algo como con de del el ella en era es esa ese eso esta este esto fue ha hay la las le lo los mas me mi muy ni no nos o para pero por que se si sin sobre su sus te tu un una uno y ya the and for with to of in on is it'.split(' '),
);

export const words = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w))
    // Plural sencillo: «recetas» y «receta» cuentan igual.
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));

const textOf = (r: NoteRow) => `${r.title ?? ''} ${(r.bodyText ?? '').slice(0, 400)}`;

export type Suggester = (note: NoteRow) => string | null;

export function makeSuggester(rows: NoteRow[]): Suggester {
  const zones = rows.filter((r) => r.kind === 'zone');
  if (!zones.length) return () => null;
  const zoneIds = new Set(zones.map((z) => z.id));
  // Palabras de cada sección: su nombre y las de sus notas directas.
  const name = new Map(zones.map((z) => [z.id, new Set(words(z.title ?? ''))]));
  const bag = new Map<string, Map<string, number>>(zones.map((z) => [z.id, new Map()]));
  const df = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === 'zone' || !r.zoneId || !zoneIds.has(r.zoneId)) continue;
    const b = bag.get(r.zoneId)!;
    for (const w of new Set(words(textOf(r)))) {
      b.set(w, (b.get(w) ?? 0) + 1);
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const total = rows.length || 1;
  return (note) => {
    const mine = new Set(words(textOf(note)));
    if (!mine.size) return null;
    let best: string | null = null;
    let top = 0;
    let second = 0;
    for (const z of zones) {
      if (z.id === note.zoneId) continue;
      let s = 0;
      const b = bag.get(z.id)!;
      const size = [...b.values()].reduce((t, n) => Math.max(t, n), 1);
      for (const w of mine) {
        if (name.get(z.id)!.has(w)) s += 3;
        const n = b.get(w);
        if (n) s += (n / size) * Math.log(total / (df.get(w) ?? 1));
      }
      if (s > top) {
        second = top;
        top = s;
        best = z.id;
      } else if (s > second) second = s;
    }
    // Solo si destaca: una coincidencia floja o empatada no se sugiere.
    return top >= 1.5 && top > second * 1.3 ? best : null;
  };
}
