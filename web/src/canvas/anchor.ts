// Abrir una nota por un punto concreto: un enlace [[Nota#^abc123]] (o
// #Encabezado), o un resultado de la búsqueda. Quien abre la nota deja aquí
// adónde ir y la hoja, al tener el texto, lo recoge y lleva hasta allí.

export type Anchor = { section: string } | { text: string };

let pending: { id: string; anchor: Anchor; at: number } | null = null;
const subs = new Set<() => void>();

export function goToAnchor(id: string, anchor: Anchor) {
  pending = { id, anchor, at: Date.now() };
  for (const fn of subs) fn();
}

// Lo que haya pendiente para esta nota (una sola vez). Si nadie la abrió a
// tiempo, se olvida: no salta al abrirla más tarde por otro camino.
export function takeAnchor(id: string): Anchor | null {
  if (!pending || pending.id !== id) return null;
  const { anchor, at } = pending;
  pending = null;
  return Date.now() - at < 5000 ? anchor : null;
}

export function onAnchor(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}
