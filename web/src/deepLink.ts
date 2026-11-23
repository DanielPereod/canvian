// #nota/<perfil>/<nota>[/<bloque>]: abre esa nota (y salta a esa casilla o
// bloque). Lo usa la extensión del navegador para «Abrir en Canvian».
const DEEP_LINK = /^#nota\/([^/]+)\/([^/]+)(?:\/([A-Za-z0-9-]+))?$/;

export type DeepLink = { profileId: string; noteId: string; blockId: string | null };

export function readDeepLink(): DeepLink | null {
  const m = DEEP_LINK.exec(location.hash);
  return m ? { profileId: m[1], noteId: m[2], blockId: m[3] ?? null } : null;
}

/** Quita el enlace de la barra de direcciones, para que recargar no vuelva a saltar. */
export function clearDeepLink() {
  history.replaceState(history.state, '', location.pathname + location.search);
}
