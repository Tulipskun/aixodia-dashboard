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
  bearerValue,
  enginePath,
  isExpired,
  mcpGatewayError,
  resolveEngineUrl,
  sessionFromStored,
} from './client-core.js'
import type { StoredSession } from './client-core.js'

// ---------------------------------------------------------------- config
// The SPA talks to the AIxodia Engine directly (no Cloudflare Worker). The base
// URL is baked in at build time from VITE_ENGINE_URL (default
// https://aixodia.dpdns.org). See .env.example and vite.config.ts for the
// local-dev options (direct 127.0.0.1:8787 or the /engine Vite proxy); the
// engine answers CORS itself per ALLOWED_ORIGINS.
const ENGINE_URL = resolveEngineUrl(import.meta.env.VITE_ENGINE_URL)

// The engine-issued short-lived token lives in sessionStorage (per-tab, cleared
// on tab close) — NEVER localStorage, and NEVER the user's GitHub PAT.
const TOKEN_KEY = 'aixodia.client-session.v1'

// Path constants are derived through enginePath() so the legacy /api/* mapping
// (/api/health -> /healthz, /api/engine/v1/* -> /v1/*) stays explicit and
// unit-testable (see test/client-core.test.js).
const P = {
  health: enginePath('/api/health'),                 // /healthz
  authToken: enginePath('/api/auth/token'),          // /v1/auth/token
  sessions: enginePath('/api/engine/v1/sessions'),   // /v1/sessions
  runs: enginePath('/api/engine/v1/runs'),           // /v1/runs
}

interface TokenResponse {
  token: string
  expires_at: number
  user: string
  scope: string
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
function readStored(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
function writeStored(s: StoredSession): void {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s)) } catch { /* storage disabled */ }
}
function clearStored(): void {
  try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* storage disabled */ }
}
function liveStored(): StoredSession | null {
  const s = readStored()
  if (!s) return null
  if (isExpired(s.expiresAt)) { clearStored(); return null }
  return s
}

/** Local session state derived from the short-lived token (no network call). */
export function getSession(): Session {
  return sessionFromStored(liveStored())
}

/**
 * Exchange a GitHub Personal Access Token for the engine's short-lived token.
 * The PAT is used ONCE by the engine to verify identity (GET api.github.com/user
 * + ALLOWED_GITHUB_USERS allowlist) and is NEVER stored in the browser; only the
 * returned opaque token (default TTL 900s, scope "client") is kept.
 */
export async function loginWithGitHubToken(githubToken: string): Promise<Session> {
  let res: Response
  try {
    // This is the only route that does NOT require a Bearer token (it issues it).
    res = await fetch(`${ENGINE_URL}${P.authToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github_token: githubToken }),
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, { error: 'Unable to connect to the engine.', code: 'NETWORK_ERROR' })
  }
  const text = await res.text()
  let data: unknown = null
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  // A 401 here means an invalid/denied PAT -> surface it on the login form; do
  // NOT fire onUnauthorized (we are not in an authenticated session yet).
  if (!res.ok) throw new ApiError(res.status, errorBody(data, res.status))
  const payload = data as Partial<TokenResponse> | null
  if (!payload || typeof payload.token !== 'string' || typeof payload.expires_at !== 'number') {
    throw new ApiError(res.status, { error: 'The engine returned an invalid token response.', code: 'INVALID_TOKEN_RESPONSE' })
  }
  writeStored({
    token: payload.token,
    expiresAt: payload.expires_at,
    user: typeof payload.user === 'string' ? payload.user : 'signed-in',
    scope: typeof payload.scope === 'string' ? payload.scope : 'client',
  })
  return getSession()
}

/** Clear the short-lived token (there is no server-side session to revoke). */
export function logout(): void {
  clearStored()
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
  const stored = liveStored()
  if (stored) headers['Authorization'] = bearerValue(stored.token)
  try {
    // Cross-origin: Authorization header instead of cookies (no same-origin
    // credentials), the engine answers CORS per ALLOWED_ORIGINS.
    return await fetch(`${ENGINE_URL}${path}`, {
      credentials: 'omit',
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
    if (res.status === 401) onUnauthorized?.()
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

// ---------------------------------------------------------------- devices (pending)
// These routes used the Worker's MCP_GATEWAY service binding. There is no
// engine equivalent yet, so fail loudly and readably instead of hitting a dead
// endpoint; the UI already catches these and shows a message.
function deviceError(feature: string): ApiError {
  const e = mcpGatewayError(feature)
  return new ApiError(e.status, { error: e.error, code: e.code })
}
export async function getDevices(_refresh = false): Promise<DevicesResponse> {
  throw deviceError('/api/devices')
}
export async function getDeviceTools(_id: string): Promise<DeviceToolsResponse> {
  throw deviceError('/api/devices/{id}/tools')
}
export async function callDeviceTool(
  _id: string,
  _tool: string,
  _args: Record<string, unknown> = {},
): Promise<DeviceActionResult> {
  throw deviceError('/api/devices/{id}/action')
}
