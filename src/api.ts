import type {
  ActionResult,
  ApiErrorBody,
  CommandsResponse,
  ConsoleConfig,
  DeviceStatus,
  DevicesResponse,
  Health,
  LoginResult,
  Session,
  ToolsResponse,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: buildHeaders(init),
    })
  } catch {
    throw new ApiError(0, { error: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', code: 'NETWORK_ERROR' })
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }

  if (!res.ok) {
    // A 401 on /api/session is expected while logged out — never redirect-loop.
    if (res.status === 401 && path !== '/api/login' && path !== '/api/session') {
      onUnauthorized?.()
    }
    const raw = (data && typeof data === 'object' ? data : {}) as Partial<ApiErrorBody>
    throw new ApiError(res.status, {
      error: raw.error || `HTTP ${res.status}`,
      code: raw.code || 'HTTP_ERROR',
      ...raw,
    })
  }
  return data as T
}

const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const getSession = () => request<Session>('/api/session')
export const getHealth = () => request<Health>('/api/health')

export const login = (username: string, password: string) =>
  post<LoginResult>('/api/login', { username, password })
export const logout = () => post<{ ok: boolean }>('/api/logout', {})

export const getConfig = () => request<ConsoleConfig>('/api/config')
export const getDevices = () => request<DevicesResponse>('/api/devices')

export const getDeviceStatus = (id: string, refresh = false) =>
  request<DeviceStatus>(
    `/api/devices/${encodeURIComponent(id)}/status${refresh ? '?refresh=1' : ''}`,
  )

export const getTools = () => request<ToolsResponse>('/api/tools')

export const postAction = (
  device: string,
  tool: string,
  args: Record<string, unknown>,
  requestId?: string,
) =>
  post<ActionResult>(`/api/devices/${encodeURIComponent(device)}/action`, {
    tool,
    arguments: args,
    requestId,
  })

export const getCommands = () => request<CommandsResponse>('/api/commands')
