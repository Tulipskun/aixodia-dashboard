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
  DEVICE_PATHS,
  engineCall,
  enginePath,
  isExpired,
  normalizeDeviceAction,
  normalizeDevices,
  normalizeDeviceTools,
  pollDeviceFlow,
  refreshEngineSession,
  requestDeviceCode,
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

// GitHub Authorization Code + PKCE. The Engine performs the token exchange;
// its OAuth client secret is never shipped to this browser.
const GITHUB_CLIENT_ID: string =
  (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined)?.trim() || 'Ov23lieKSrKCRs5YKwdO'
const GITHUB_REDIRECT_URI = window.location.origin

// Engine-issued access + refresh credentials live in sessionStorage (per-tab,
// cleared on tab close) — NEVER localStorage, and NEVER the user's GitHub PAT.
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
  refresh_token: string
  refresh_expires_at: number
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
    if (typeof parsed.refreshToken !== 'undefined' && typeof parsed.refreshToken !== 'string') return null
    if (typeof parsed.refreshExpiresAt !== 'undefined' && typeof parsed.refreshExpiresAt !== 'number') return null
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
  const accessValid = !isExpired(s.expiresAt)
  const refreshValid = Boolean(s.refreshToken) && !isExpired(s.refreshExpiresAt)
  if (!accessValid && !refreshValid) { clearStored(); return null }
  return s
}

/** Local session state: valid access or refresh credentials count as signed in. */
export function getSession(): Session {
  return sessionFromStored(liveStored())
}

const OAUTH_PENDING_KEY = 'aixodia.github-oauth.pending.v1'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Start GitHub authorization in the system browser with PKCE S256. */
export async function beginGitHubOAuth(): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64Url(new Uint8Array(digest))
  sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({
    verifier, state, redirectUri: GITHUB_REDIRECT_URI,
  }))
  const authorize = new URL('https://github.com/login/oauth/authorize')
  authorize.searchParams.set('client_id', GITHUB_CLIENT_ID)
  authorize.searchParams.set('redirect_uri', GITHUB_REDIRECT_URI)
  authorize.searchParams.set('scope', 'read:user')
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  window.location.assign(authorize.toString())
}

/** Validate state and exchange the authorization code for Engine credentials. */
export async function completeGitHubOAuth(code: string, state: string): Promise<Session> {
  let pending: { verifier: string; state: string; redirectUri: string } | null = null
  try { pending = JSON.parse(sessionStorage.getItem(OAUTH_PENDING_KEY) || 'null') }
  catch { pending = null }
  if (!pending?.verifier || pending.state !== state) {
    throw new ApiError(0, { error: 'GitHub sign-in state did not match. Start again.', code: 'OAUTH_STATE_MISMATCH' })
  }
  let res: Response
  try {
    res = await fetch(`${ENGINE_URL}/v1/auth/github/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri, client_id: GITHUB_CLIENT_ID,
      }),
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, { error: 'Unable to connect to the engine.', code: 'NETWORK_ERROR' })
  }
  const text = await res.text()
  let data: unknown = null
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  if (!res.ok) throw new ApiError(res.status, errorBody(data, res.status))
  const payload = data as Partial<TokenResponse> | null
  if (!payload || typeof payload.token !== 'string' || typeof payload.expires_at !== 'number'
      || typeof payload.refresh_token !== 'string' || typeof payload.refresh_expires_at !== 'number') {
    throw new ApiError(res.status, { error: 'The engine returned an invalid session response.', code: 'INVALID_TOKEN_RESPONSE' })
  }
  writeStored({
    token: payload.token, expiresAt: payload.expires_at,
    refreshToken: payload.refresh_token, refreshExpiresAt: payload.refresh_expires_at,
    user: typeof payload.user === 'string' ? payload.user : 'signed-in',
    scope: typeof payload.scope === 'string' ? payload.scope : 'client',
  })
  sessionStorage.removeItem(OAUTH_PENDING_KEY)
  return getSession()
}

// ---------------------------------------------------------------- token refresh
const ACCESS_REFRESH_SKEW_MS = 120_000
let refreshInFlight: Promise<StoredSession> | null = null

/** Renew the short-lived Engine access token without sending the user through GitHub again. */
async function ensureAccessSession(): Promise<StoredSession | null> {
  const stored = readStored()
  if (!stored) return null
  const now = Date.now()
  if (!isExpired(stored.expiresAt, now + ACCESS_REFRESH_SKEW_MS)) return stored
  const refreshCredential = stored.refreshToken
  if (!refreshCredential || isExpired(stored.refreshExpiresAt, now)) {
    clearStored()
    onUnauthorized?.()
    return null
  }
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const result = await refreshEngineSession(fetch, ENGINE_URL, refreshCredential)
    if (!result.ok) {
      const error = new ApiError(result.status, { error: result.error, code: result.code })
      if (result.status === 401) {
        clearStored()
        onUnauthorized?.()
      }
      throw error
    }
    const current = readStored()
    if (!current || current.refreshToken !== refreshCredential) {
      // Sign-out or a new login may have happened while the refresh request
      // was in flight. Never resurrect that previous session.
      if (current && !isExpired(current.expiresAt)) return current
      throw new ApiError(0, { error: 'The session changed while it was being refreshed.', code: 'SESSION_CHANGED' })
    }
    const next: StoredSession = {
      ...result.session,
      user: result.session.user || current.user || stored.user || 'signed-in',
      scope: result.session.scope || current.scope || stored.scope || 'client',
    }
    writeStored(next)
    return next
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
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
  const stored = await ensureAccessSession()
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

// ---------------------------------------------------------------- devices
// The engine owns the device/MCP gateway routes directly. Every call carries
// the same short-lived Bearer token as the rest of /v1/*. An empty registry
// comes back as { devices: [], note } with HTTP 200 — normalizeDevices keeps
// the note so the UI can show a readable message instead of an error.
async function deviceCall<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await ensureAccessSession()
  const result = await engineCall(fetch, ENGINE_URL, path, {
    token: session?.token,
    method: init.method,
    body: init.body,
  })
  if (!result.ok) {
    if (result.status === 401) onUnauthorized?.()
    throw new ApiError(result.status, { error: result.error, code: result.code })
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
