import type { MailLinkRow } from '../api';

// Las casillas vinculadas a un hilo de Outlook (desde la extensión), por su id
// de bloque. Llegan con el perfil (y con cada cambio en tiempo real); el
// editor las enseña como una ficha más detrás de la tarea.

export type MailLink = { subject: string | null; url: string | null };

let byBlock = new Map<string, MailLink[]>();
const EVENT = 'canvian:mail-links';

export function setMailLinks(rows: MailLinkRow[] | undefined) {
  const next = new Map<string, MailLink[]>();
  for (const r of rows ?? []) {
    const list = next.get(r.blockId) ?? [];
    // Dos vínculos al mismo hilo (por id y por asunto) cuentan como uno.
    if (!list.some((l) => (l.subject ?? '') === (r.subject ?? ''))) list.push({ subject: r.subject, url: r.url });
    next.set(r.blockId, list);
  }
  const same = next.size === byBlock.size && [...next].every(([k, v]) => JSON.stringify(v) === JSON.stringify(byBlock.get(k)));
  if (same) return;
  byBlock = next;
  window.dispatchEvent(new Event(EVENT));
}

export const mailLinksOf = (blockId: string | null | undefined) => (blockId ? byBlock.get(blockId) : undefined);

export function onMailLinks(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
