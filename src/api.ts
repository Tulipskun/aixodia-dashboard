import type {
  ApiErrorBody,
  DeviceActionResult,
  DeviceToolsResponse,
  DevicesResponse,
  EngineEvent,
  EngineRun,
  EngineSession,
  EngineStatus,
  EngineTurn,
  Health,
  Session,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: ApiErrorBody

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code || 'HTTP_ERROR'
    this.body = body
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

function buildHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const extra = init.headers
  if (extra instanceof Headers) {
    extra.forEach((value, key) => { headers[key] = value })
  } else if (Array.isArray(extra)) {
    extra.forEach(([key, value]) => { headers[key] = value })
  } else if (extra) {
    Object.assign(headers, extra)
  }
  return headers
}

async function fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: buildHeaders(init),
    })
  } catch {
    throw new ApiError(0, { error: 'Unable to connect to the server.', code: 'NETWORK_ERROR' })
  }
}
function errorBody(data: unknown, status: number): ApiErrorBody {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<ApiErrorBody>
  return { error: raw.error || `HTTP ${status}`, code: raw.code || 'HTTP_ERROR', ...raw }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchResponse(path, init)
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/session') onUnauthorized?.()
    throw new ApiError(res.status, errorBody(data, res.status))
  }
  return data as T
}
async function requestText(path: string): Promise<string> {
  const res = await fetchResponse(path)
  const text = await res.text()
  if (!res.ok) {
    let data: unknown = null
    try { data = JSON.parse(text) } catch { data = null }
    if (res.status === 401) onUnauthorized?.()
    throw new ApiError(res.status, errorBody(data, res.status))
  }
  return text
}
const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const getSession = () => request<Session>('/api/session')
export const getHealth = () => request<Health>('/api/health')
export const logout = () => post<{ ok: boolean }>('/api/logout', {})

export const getEngineStatus = () => request<EngineStatus>('/api/engine/status')
export const getEngineSessions = () => request<{ sessions: EngineSession[] }>('/api/engine/v1/sessions')
export const createEngineSession = (title = 'New chat') =>
  request<EngineSession>('/api/engine/v1/sessions', { method: 'POST', body: JSON.stringify({ title }) })
export const getEngineTurns = (id: string) =>
  request<{ turns: EngineTurn[] }>(`/api/engine/v1/sessions/${encodeURIComponent(id)}/turns?limit=100`)
export const deleteEngineSession = (id: string) =>
  request<{ deleted: boolean }>(`/api/engine/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const startEngineRun = (sessionId: string, message: string) =>
  post<{ run: EngineRun }>('/api/engine/v1/runs', { session_id: sessionId, message })
export const getEngineEvents = (runId: string, after: number) =>
  requestText(`/api/engine/v1/runs/${encodeURIComponent(runId)}/events?after=${after}&poll=1`)
export const cancelEngineRun = (runId: string) =>
  post<{ run: EngineRun }>(`/api/engine/v1/runs/${encodeURIComponent(runId)}/cancel`, {})

export const getDevices = (refresh = false) =>
  request<DevicesResponse>(`/api/devices${refresh ? '?refresh=1' : ''}`)
export const getDeviceTools = (id: string) =>
  request<DeviceToolsResponse>(`/api/devices/${encodeURIComponent(id)}/tools`)
export const callDeviceTool = (id: string, tool: string, args: Record<string, unknown> = {}) =>
  post<DeviceActionResult>(`/api/devices/${encodeURIComponent(id)}/action`, { tool, arguments: args })
