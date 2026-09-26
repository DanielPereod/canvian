export type BackgroundKind = 'plain' | 'dots' | 'grid' | 'stars' | 'fireflies' | 'aurora';

export type Profile = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  background: BackgroundKind;
  position: number;
};

export type Viewport = { x: number; y: number; zoom: number };

export type TaskStatus = 'todo' | 'doing' | 'done';

export type NoteKind = 'text' | 'task' | 'link' | 'image' | 'checklist' | 'code' | 'zone';

export type NoteRow = {
  id: string;
  profileId: string;
  kind: NoteKind;
  title: string | null;
  bodyJson: string | null;
  bodyText: string | null;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
  zoneId: string | null;
  status: TaskStatus | null;
  priority: number | null;
  dueAt: string | null;
  doneAt: string | null;
  // JSON con los valores de las propiedades personalizadas, por id de propiedad.
  props: string;
  updatedAt: string;
};

export function parseProps(raw: string | null | undefined): Record<string, PropValue> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export type PropertyType = 'text' | 'number' | 'select' | 'date' | 'checkbox' | 'url';
export type PropValue = string | number | boolean | null;

export type PropertyDef = {
  id: string;
  profileId: string;
  name: string;
  type: PropertyType;
  options: string[];
  position: number;
};

export type EdgeRow = {
  id: string;
  profileId: string;
  fromId: string;
  toId: string;
  label: string | null;
};

export type LayoutItem = {
  id: string;
  x: number;
  y: number;
  w?: number | null;
  h?: number | null;
  zoneId?: string | null;
};

export type SearchHit = { id: string; title: string | null; bodyText: string | null; kind: NoteKind };

// Lo que se envía al servidor: igual que una fila pero con `props` como objeto.
export type NoteInput = Partial<Omit<NoteRow, 'id' | 'profileId' | 'updatedAt' | 'props'>> & {
  props?: Record<string, PropValue>;
};

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
  updateProfile: (id: string, patch: Partial<Pick<Profile, 'name' | 'color' | 'background'>>) =>
    request<Profile>('PATCH', `/profiles/${id}`, patch),
  getViewport: (id: string) => request<Viewport>('GET', `/profiles/${id}/viewport`),
  saveViewport: (id: string, v: Viewport) => request('PUT', `/profiles/${id}/viewport`, v),
  canvas: (profileId: string) =>
    request<{ notes: NoteRow[]; edges: EdgeRow[] }>('GET', `/profiles/${profileId}/canvas`),
  createNote: (profileId: string, note: NoteInput & { id: string; x: number; y: number }) =>
    request<NoteRow>('POST', `/profiles/${profileId}/notes`, note),
  patchNote: (id: string, patch: NoteInput) =>
    request<NoteRow>('PATCH', `/notes/${id}`, patch),
  saveLayout: (items: LayoutItem[]) => request('PATCH', '/notes/layout', items),
  deleteNote: (id: string) => request('DELETE', `/notes/${id}`),
  createEdge: (profileId: string, edge: { id: string; fromId: string; toId: string }) =>
    request<EdgeRow>('POST', `/profiles/${profileId}/edges`, edge),
  deleteEdge: (id: string) => request('DELETE', `/edges/${id}`),
  properties: (profileId: string) => request<PropertyDef[]>('GET', `/profiles/${profileId}/properties`),
  createProperty: (profileId: string, def: { id: string; name: string; type: PropertyType; options?: string[] }) =>
    request<PropertyDef>('POST', `/profiles/${profileId}/properties`, def),
  updateProperty: (id: string, patch: Partial<Pick<PropertyDef, 'name' | 'options' | 'position'>>) =>
    request<PropertyDef>('PATCH', `/properties/${id}`, patch),
  deleteProperty: (id: string) => request('DELETE', `/properties/${id}`),
  search: (profileId: string, q: string) =>
    request<SearchHit[]>('GET', `/profiles/${profileId}/search?q=${encodeURIComponent(q)}`),
};
