import type {
  ArchivePayload,
  CarryPayload,
  DayPayload,
  OrderStatus,
  Priority,
  Profile,
  ProfilesPayload,
  SessionPayload,
  ShoppingPayload,
  SmokeKind,
  SmokePayload,
  SpanPayload,
} from '../shared/types.ts'

export class AuthError extends Error {
  constructor() {
    super('Нужен вход.')
    this.name = 'AuthError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new Error('Нет связи с сервером.')
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string }
  if (response.status === 401 && path !== '/api/login') throw new AuthError()
  if (!response.ok) throw new Error(data.error || 'Не сохранилось.')
  return data as T
}

export const api = {
  session: () => request<SessionPayload>('/api/session'),
  login: (password: string) =>
    request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  profiles: () => request<ProfilesPayload>('/api/profiles'),
  addProfile: (name: string) =>
    request<ProfilesPayload>('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) }),
  updateProfile: (id: string, patch: { name?: string; theme?: Profile['theme'] }) =>
    request<ProfilesPayload>(`/api/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProfile: (id: string) => request<ProfilesPayload>(`/api/profiles/${id}`, { method: 'DELETE' }),
  useProfile: (id: string) => request<ProfilesPayload>(`/api/profiles/${id}/use`, { method: 'POST' }),
  day: (day: string) => request<DayPayload>(`/api/days/${day}`),
  span: (from: string, to: string) => request<SpanPayload>(`/api/span/${from}/${to}`),
  add: (day: string, title: string) =>
    request<DayPayload>(`/api/days/${day}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  reorder: (day: string, ids: string[]) =>
    request<DayPayload>(`/api/days/${day}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  carry: (day: string) => request<CarryPayload>(`/api/days/${day}/carry`, { method: 'POST' }),
  addSubtask: (id: string, title: string) =>
    request<DayPayload>(`/api/tasks/${id}/subtasks`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  reorderSubtasks: (id: string, ids: string[]) =>
    request<DayPayload>(`/api/tasks/${id}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  archive: () => request<ArchivePayload>('/api/archive'),
  update: (id: string, patch: { title?: string; priority?: Priority; done?: boolean }) =>
    request<DayPayload>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<DayPayload>(`/api/tasks/${id}`, { method: 'DELETE' }),
  smoke: (day: string) => request<SmokePayload>(`/api/smoke/${day}`),
  smokeStock: (day: string, patch: { packs?: number; open?: number; joints?: number }) =>
    request<SmokePayload>(`/api/smoke/${day}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  smokeBreak: (day: string, kind: SmokeKind) =>
    request<SmokePayload>(`/api/smoke/${day}`, { method: 'POST', body: JSON.stringify({ kind }) }),
  smokeUndo: (day: string, id: string) => request<SmokePayload>(`/api/smoke/${day}/breaks/${id}`, { method: 'DELETE' }),
  shopping: () => request<ShoppingPayload>('/api/shopping'),
  addGrocery: (title: string) =>
    request<ShoppingPayload>('/api/shopping/groceries', { method: 'POST', body: JSON.stringify({ title }) }),
  renameGrocery: (id: string, title: string) =>
    request<ShoppingPayload>(`/api/shopping/groceries/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  buyGrocery: (id: string) => request<ShoppingPayload>(`/api/shopping/groceries/${id}`, { method: 'DELETE' }),
  addOrder: (title: string, shop: string) =>
    request<ShoppingPayload>('/api/shopping/orders', { method: 'POST', body: JSON.stringify({ title, shop }) }),
  updateOrder: (id: string, patch: { title?: string; shop?: string; status?: OrderStatus }) =>
    request<ShoppingPayload>(`/api/shopping/orders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteOrder: (id: string) => request<ShoppingPayload>(`/api/shopping/orders/${id}`, { method: 'DELETE' }),
}
