import type {
  ApiErrorBody,
  DeviceActionResult,
  DeviceToolsResponse,
  DevicesResponse,
  EngineRun,
  EngineSession,
  EngineStatus,
  EngineTurn,
  Health,
  Session,
} from './types'
import {
  DEVICE_PATHS,
  engineCall,
  enginePath,
  normalizeDeviceAction,
  normalizeDevices,
  normalizeDeviceTools,
  resolveEngineUrl,
} from './client-core.js'

// ---------------------------------------------------------------- config
// The SPA talks to the AIxodia Engine directly (no Cloudflare Worker), and that
// origin sits behind Cloudflare Access. VITE_ENGINE_URL is the Access-protected
// hostname (default https://aixodia.dpdns.org); the browser's Access cookie is
// what authorises every call. See .env.example and vite.config.ts for the
// local-dev options (direct 127.0.0.1:8787 or the /engine Vite proxy); the
// engine answers CORS itself per ALLOWED_ORIGINS.
const ENGINE_URL = resolveEngineUrl(import.meta.env.VITE_ENGINE_URL)

// Path constants are derived through enginePath() so the legacy /api/* mapping
// (/api/health -> /healthz, /api/engine/v1/* -> /v1/*) stays explicit and
// unit-testable (see test/client-core.test.js).
const P = {
  health: enginePath('/api/health'),                 // /healthz
  sessions: enginePath('/api/engine/v1/sessions'),   // /v1/sessions
  runs: enginePath('/api/engine/v1/runs'),           // /v1/runs
}

interface HealthzResponse {
  ok?: boolean
  version?: string | null
  started?: number | null
  uptime_seconds?: number | null
  cpu_percent?: number | null
  memory_used_bytes?: number | null
  memory_total_bytes?: number | null
  memory_percent?: number | null
}
// ---------------------------------------------------------------- error
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

// ---------------------------------------------------------------- session state
//
// Sign-in is Cloudflare Access, in front of the engine hostname. There is no
// credential for this SPA to hold: Access runs the GitHub / one-time-PIN login,
// sets `CF_Authorization` for the engine's own origin, and every request the
// browser makes to that origin carries it automatically. What is left here is
// a cached, non-secret profile so the header can show who is signed in without
// asking the engine on every render.
const PROFILE_KEY = 'aixodia.access-profile.v1'

interface AccessProfile {
  username: string
  expiresAt: number
}

function readProfile(): AccessProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AccessProfile
    if (!parsed || typeof parsed.username !== 'string' || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt * 1000 <= Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

function writeProfile(profile: AccessProfile): void {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)) } catch { /* storage disabled */ }
}

function clearProfile(): void {
  try { localStorage.removeItem(PROFILE_KEY) } catch { /* storage disabled */ }
}

/** Cached Access identity. `authenticated` is optimistic: the engine is the authority. */
export function getSession(): Session {
  const profile = readProfile()
  if (!profile) return { authenticated: false, username: null, expiresAt: null }
  return {
    authenticated: true,
    username: profile.username,
    expiresAt: new Date(profile.expiresAt * 1000).toISOString(),
  }
}

/**
 * Ask the engine who the caller is. `Cf-Access-Jwt-Assertion` is added by
 * Cloudflare, never by this page, so a 200 here proves the Access session is
 * live. Returns `null` when Access rejects the request.
 */
export async function refreshSessionFromEngine(): Promise<Session> {
  let res: Response
  try {
    res = await fetch(`${ENGINE_URL}/v1/auth/whoami`, { credentials: 'include', cache: 'no-store' })
  } catch {
    // The engine being unreachable is not the same as being signed out.
    return getSession()
  }
  if (res.status === 401 || res.status === 403) {
    clearProfile()
    return { authenticated: false, username: null, expiresAt: null }
  }
  if (!res.ok) return getSession()
  const body = (await res.json().catch(() => null)) as { access_subject?: string | null } | null
  if (!body) return getSession()

  const username = (body.access_subject || '').trim()
  if (!username) {
    clearProfile()
    return { authenticated: false, username: null, expiresAt: null }
  }
  // Access sessions last as long as the application's session_duration; the
  // exact expiry is inside the JWT, which this page cannot read. Cache for a
  // day and let the next whoami call correct it.
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60
  writeProfile({ username, expiresAt })
  return {
    authenticated: true,
    username,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

/**
 * Send the browser to the Access login page and come back to this exact URL.
 * Cloudflare handles the GitHub / one-time-PIN choice; nothing here builds an
 * OAuth request.
 */
export function signIn(): void {
  clearProfile()
  const here = `${window.location.origin}${window.location.pathname}${window.location.search}`
  window.location.assign(`${ENGINE_URL}/cdn-cgi/access/login?redirect_url=${encodeURIComponent(here)}`)
}

/**
 * Sign out. Only Cloudflare can end an Access session, so this clears the local
 * profile and hands the browser to the Access logout endpoint.
 */
export function logout(): void {
  clearProfile()
  const here = `${window.location.origin}${window.location.pathname}`
  window.location.assign(`${ENGINE_URL}/cdn-cgi/access/logout?redirect_url=${encodeURIComponent(here)}`)
}

// ---------------------------------------------------------------- transport
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
function errorBody(data: unknown, status: number): ApiErrorBody {
  const raw = (data && typeof data === 'object' ? data : {}) as Partial<ApiErrorBody>
  return { error: raw.error || `HTTP ${status}`, code: raw.code || 'HTTP_ERROR', ...raw }
}
async function fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = buildHeaders(init)
  try {
    // Same-origin through the proxy in dev, cross-origin in production: either
    // way `credentials: 'include'` is what carries the Access cookie.
    return await fetch(`${ENGINE_URL}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      ...init,
      headers,
    })
  } catch {
    throw new ApiError(0, { error: 'Unable to connect to the engine.', code: 'NETWORK_ERROR' })
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchResponse(path, init)
  const text = await res.text()
  let data: unknown = null
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) onUnauthorized?.()
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
    if (res.status === 401 || res.status === 403) onUnauthorized?.()
    throw new ApiError(res.status, errorBody(data, res.status))
  }
  return text
}
const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

// ---------------------------------------------------------------- health
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function fetchHealthz(): Promise<HealthzResponse> {
  return request<HealthzResponse>(P.health)
}
export async function getHealth(): Promise<Health> {
  const data = await fetchHealthz()
  // No OAuth app to configure anymore: auth lives on the engine's token endpoint.
  return { ok: data?.ok === true, authConfigured: true }
}
export async function getEngineStatus(): Promise<EngineStatus> {
  const data = await fetchHealthz()
  return {
    configured: true,
    online: data?.ok === true,
    checkedAt: new Date().toISOString(),
    reason: null,
    version: data.version ?? null,
    startedAt: finite(data.started),
    uptimeSeconds: finite(data.uptime_seconds),
    metrics: {
      cpuPercent: finite(data.cpu_percent),
      memoryUsedBytes: finite(data.memory_used_bytes),
      memoryTotalBytes: finite(data.memory_total_bytes),
      memoryPercent: finite(data.memory_percent),
    },
  }
}

// ---------------------------------------------------------------- engine v1
export const getEngineSessions = () => request<{ sessions: EngineSession[] }>(P.sessions)
export const createEngineSession = (title = 'New chat') => post<EngineSession>(P.sessions, { title })
export const getEngineTurns = (id: string) =>
  request<{ turns: EngineTurn[] }>(`${P.sessions}/${encodeURIComponent(id)}/turns?limit=100`)
export const deleteEngineSession = (id: string) =>
  request<{ deleted: boolean }>(`${P.sessions}/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const startEngineRun = (sessionId: string, message: string) =>
  post<{ run: EngineRun }>(P.runs, { session_id: sessionId, message })
export const getEngineEvents = (runId: string, after: number) =>
  requestText(`${P.runs}/${encodeURIComponent(runId)}/events?after=${after}&poll=1`)
export const cancelEngineRun = (runId: string) =>
  post<{ run: EngineRun }>(`${P.runs}/${encodeURIComponent(runId)}/cancel`, {})

// ---------------------------------------------------------------- devices
// The engine owns the device/MCP gateway routes directly. Every call carries
// the same short-lived Bearer token as the rest of /v1/*. An empty registry
// comes back as { devices: [], note } with HTTP 200 — normalizeDevices keeps
// the note so the UI can show a readable message instead of an error.
async function deviceCall<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const result = await engineCall(fetch, ENGINE_URL, path, {
    method: init.method,
    body: init.body,
  })
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) onUnauthorized?.()
    throw new ApiError(result.status, {
      error: result.error ?? `HTTP ${result.status}`,
      code: result.code ?? 'HTTP_ERROR',
    })
  }
  return result.data as T
}

export async function getDevices(_refresh = false): Promise<DevicesResponse> {
  const data = await deviceCall<unknown>(DEVICE_PATHS.list)
  return normalizeDevices(data)
}
export async function getDeviceTools(id: string): Promise<DeviceToolsResponse> {
  const data = await deviceCall<unknown>(DEVICE_PATHS.tools(id))
  return normalizeDeviceTools(data)
}
export async function callDeviceTool(
  id: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<DeviceActionResult> {
  const data = await deviceCall<unknown>(DEVICE_PATHS.action(id), {
    method: 'POST',
    body: { tool, arguments: args },
  })
  return normalizeDeviceAction(data, id, tool)
}
