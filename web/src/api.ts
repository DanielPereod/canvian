export type Profile = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  position: number;
};

export type Viewport = { x: number; y: number; zoom: number };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'Algo ha fallado', res.status);
  return data as T;
}

export const api = {
  status: () => request<{ setupDone: boolean; authenticated: boolean }>('GET', '/auth/status'),
  setup: (password: string) => request('POST', '/auth/setup', { password }),
  login: (password: string) => request('POST', '/auth/login', { password }),
  logout: () => request('POST', '/auth/logout'),
  profiles: () => request<Profile[]>('GET', '/profiles'),
  createProfile: (name: string) => request<Profile>('POST', '/profiles', { name }),
  getViewport: (id: string) => request<Viewport>('GET', `/profiles/${id}/viewport`),
  saveViewport: (id: string, v: Viewport) => request('PUT', `/profiles/${id}/viewport`, v),
};
