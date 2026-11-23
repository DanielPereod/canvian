import { PRESET } from '../config.js';

// La dirección y la llave de Canvian, y las llamadas a su API (/ext/…).
// Las usan el popup, las opciones y el panel de Outlook (páginas de la
// extensión, con permiso para la dirección de Canvian).

export async function getConfig() {
  // `profile` null: el que esté abierto en Canvian (lo decide el servidor).
  // Se guarda como «profileChoice»: la 0.1 guardaba siempre el primero en «profile».
  const saved = await chrome.storage.local.get(['url', 'token', 'profileChoice']);
  return {
    url: (saved.url ?? PRESET.url ?? '').replace(/\/+$/, ''),
    token: saved.token ?? PRESET.token ?? '',
    profile: saved.profileChoice || null,
  };
}

export async function setConfig({ profile, ...rest }) {
  await chrome.storage.local.set({ ...rest, ...(profile !== undefined ? { profileChoice: profile || null } : {}) });
}

/** El patrón de permiso para la dirección del servidor («https://casa.example/*»). */
export const originPattern = (url) => `${new URL(url).origin}/*`;

export async function hasAccess(url) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const { url, token, profile } = await getConfig();
  if (!url || !token) throw new ApiError('Falta conectar la extensión con tu Canvian (abre las opciones).', 0);
  const q = new URLSearchParams();
  if (profile) q.set('profile', profile);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const full = `${url}/ext${path}${method === 'GET' && [...q].length ? `?${q}` : ''}`;
  let res;
  try {
    res = await fetch(full, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(profile && !('profile' in body) ? { profile, ...body } : body) : undefined,
    });
  } catch {
    throw new ApiError(`No llego a ${url}. ¿Está en marcha Canvian y tiene permiso la extensión?`, 0);
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `Error ${res.status}`, res.status);
  return data;
}
