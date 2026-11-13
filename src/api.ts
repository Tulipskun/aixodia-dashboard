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
// hostname (default https://engine.aixodia.dpdns.org); the browser's Access cookie is
// what authorises every call. See .env.example and vite.config.ts for the
// local-dev options (direct 127.0.0.1:8787 or the /engine Vite proxy); the
// engine answers CORS itself per ALLOWED_ORIGINS.
const ENGINE_URL = resolveEngineUrl(import.meta.env.VITE_ENGINE_URL)

/**
 * The auth Worker, reached through this origin's proxy.
 *
 * Sign-in must not go through the engine: it is an agent that also exposes
 * device-control routes, and its uptime used to be a login requirement. The same
 * proxy carries both so the Access cookie, which is set per host, applies to them
 * equally.
 */
const AUTH_URL = `${ENGINE_URL.replace(/\/$/, '')}`

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

/** What the auth Worker hands back when it issues a token. */
export interface GateToken {
  token: string
  state: 'pending'
  reference: string
  confirm_path: string
  expires_at: number
}

export type GateState = 'pending' | 'active' | 'expired' | 'revoked' | 'unknown'

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
 * Start an email sign-in.
 *
 * The auth Worker issues a token in state `pending`, which is useless until the
 * user confirms it. That two-step exists so that asking for a token is not enough
 * to get one: the address has to be on the allowlist, and the person holding it
 * has to prove it by opening the link.
 *
 * `AUTH_URL`, not `ENGINE_URL`: this is the auth Worker. It answers whether or not
 * the engine is running, which is the point of the split — an agent being down
 * should not lock anyone out of the console.
 */
export async function requestEmailToken(email: string): Promise<GateToken> {
  const res = await fetch(`${AUTH_URL}/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    credentials: 'include',
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = String(body?.code || '')
    // A deployment with no allowlist is a setup problem, not a refused address;
    // saying so is what stops an operator from debugging the wrong half.
    if (code === 'NO_ALLOWLIST') {
      throw new Error('This console has no allowed emails configured yet.')
    }
    if (code === 'EMAIL_NOT_ALLOWED' || code === 'BAD_EMAIL') {
      throw new Error('That email is not allowed to sign in.')
    }
    throw new Error('Could not start sign-in. Try again.')
  }
  if (!body?.['token'] || !body?.['confirm_path']) {
    throw new Error('The sign-in service returned an unexpected answer.')
  }
  return body as unknown as GateToken
}

/**
 * Poll a pending token until it is confirmed.
 *
 * The token is the credential, so it is sent as a bearer header rather than in the
 * URL: a token in a query string ends up in logs and history.
 */
export async function gateStatus(token: string): Promise<GateState> {
  const res = await fetch(`${AUTH_URL}/auth/status`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
    cache: 'no-store',
  })
  if (!res.ok) return 'expired'
  const body = (await res.json().catch(() => null)) as { state?: string } | null
  const state = String(body?.state || '')
  if (state === 'active' || state === 'pending' || state === 'expired' || state === 'revoked') {
    return state as GateState
  }
  return 'expired'
}

/**
 * Send the browser to the engine so Cloudflare Access runs the login, then come
 * back to this exact URL.
 *
 * Two mistakes were possible here and both showed up as a broken sign-in:
 *
 * * Navigating to `/cdn-cgi/access/login` returns 404. That path only exists on
 *   an Access application configured with path-based rules; this hostname is
 *   protected as a whole, so there is no such endpoint. A request to any normal
 *   URL is redirected to the login instead.
 *
 * * Passing the dashboard URL as `redirect_url` does nothing here. Access echoes
 *   the path it was asked for, not the query parameter, so the user would be
 *   returned to the engine root, which has no page.
 *
 * So the browser goes to the engine's own whoami endpoint, which is guarded,
 * and Access returns it there once the session exists. The SPA then loads
 * again at its normal address from the link in the app shell — no round trip
 * through a page that does not exist.
 */
export function signIn(): void {
  clearProfile()
  // This origin's own path, not the engine's hostname: Access sets its session
  // cookie per host, and a cookie on engine.aixodia.dpdns.org is invisible to the
  // SPA that runs here. Going through the same-origin proxy means the login and
  // every later fetch share one host.
  window.location.assign('/engine/v1/auth/whoami')
}

/**
 * Sign out. Only Cloudflare can end an Access session, so this clears the local
 * profile and hands the browser to the Access logout endpoint.
 */
export function logout(): void {
  clearProfile()
  const here = `${window.location.origin}${window.location.pathname}`
  window.location.assign(`/engine/cdn-cgi/access/logout?redirect_url=${encodeURIComponent(here)}`)
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
