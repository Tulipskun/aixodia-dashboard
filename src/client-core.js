// Pure, framework-agnostic helpers shared by the browser client (src/api.ts)
// and the Node test suite. Nothing here references browser globals directly:
// `fetch` is injected into the network helpers, and there is no import.meta.env
// / sessionStorage access, so `node --test` can import this module directly.

/** @typedef {{ token: string, expiresAt: number, refreshToken?: string, refreshExpiresAt?: number, user: string, scope: string }} StoredSession */
/** @typedef {{ authenticated: boolean, username: string | null, expiresAt: string | null }} ClientSession */

/**
 * Where the SPA reaches the engine.
 *
 * A relative path, not the engine's own hostname: Cloudflare Access sets its
 * session cookie per host, so a browser signed in at engine.aixodia.dpdns.org
 * carries no credential at aixodia.dpdns.org and every cross-host fetch arrived
 * unauthenticated. `/engine` is served by the Pages Function in
 * functions/engine/[[path]].js, which forwards to the engine on the same origin
 * so the cookie and the request stay on one host.
 */
export const DEFAULT_ENGINE_URL = '/engine'

/**
 * Normalize the configured engine base URL.
 * @param {unknown} value
 * @returns {string}
 */
export function resolveEngineUrl(value) {
  const base = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_ENGINE_URL
  return base.replace(/\/+$/, '')
}

/**
 * True when a unix-seconds expiry is at/before now, or is not a finite number.
 * @param {unknown} expiresAtSeconds
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isExpired(expiresAtSeconds, nowMs = Date.now()) {
  if (typeof expiresAtSeconds !== 'number' || !Number.isFinite(expiresAtSeconds)) return true
  return expiresAtSeconds * 1000 <= nowMs
}

/**
 * Map the historical client-facing /api/* paths to the engine's direct paths.
 * /api/session, /api/auth/github and /api/logout were removed entirely: the
 * session is local-only now and login is POST /v1/auth/token.
 * @param {string} legacyPath
 * @returns {string}
 */
export function enginePath(legacyPath) {
  if (legacyPath === '/api/health' || legacyPath === '/api/engine/status') return '/healthz'
  if (legacyPath.startsWith('/api/engine/')) return legacyPath.slice('/api/engine'.length)
  if (legacyPath === '/api/engine') return '/'
  return legacyPath
}

// ---------------------------------------------------------------- devices
// The engine owns the device/MCP gateway routes directly (no Worker service
// binding). These paths are the real /v1/* endpoints; api.ts calls them with
// the browser's Cloudflare Access cookie, so no token is passed here.

export const DEVICE_PATHS = {
  list: '/v1/devices',
  tools: (id) => `/v1/devices/${encodeURIComponent(id)}/tools`,
  action: (id) => `/v1/devices/${encodeURIComponent(id)}/action`,
}

/**
 * One engine call. Returns a discriminated result instead of throwing so it
 * stays easy to unit-test with a mock fetch. `api.ts` turns a failure into an
 * ApiError and treats 401/403 as an expired Cloudflare Access session.
 *
 * @param {(url: string, init: object) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} fetchFn
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: unknown, error?: string, code?: string }>}
 */
export async function engineCall(fetchFn, baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetchFn(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      error: 'Unable to connect to the engine.',
      data: null,
    }
  }
  const text = typeof res.text === 'function' ? await res.text() : ''
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = null }
  }
  if (!res.ok) {
    const raw = (data && typeof data === 'object') ? data : {}
    return {
      ok: false,
      status: res.status,
      code: raw.code || 'HTTP_ERROR',
      error: raw.error || `HTTP ${res.status}`,
      data,
    }
  }
  return { ok: true, status: res.status, data }
}

/** @returns {string} */
function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Normalize one engine device record into the client's Device shape. */
export function normalizeDevice(raw) {
  const item = (raw && typeof raw === 'object') ? raw : {}
  const s = (item.status && typeof item.status === 'object') ? item.status : {}
  const latency = typeof s.latencyMs === 'number'
    ? s.latencyMs
    : (typeof s.latency_ms === 'number' ? s.latency_ms : null)
  return {
    id: str(item.id, str(item.name)),
    name: str(item.name, str(item.id)),
    host: str(item.host),
    subtitle: typeof item.subtitle === 'string' ? item.subtitle : undefined,
    tag: typeof item.tag === 'string' ? item.tag : undefined,
    accent: typeof item.accent === 'string' ? item.accent : undefined,
    status: {
      online: s.online === true,
      latencyMs: latency,
      checkedAt: str(s.checkedAt),
      reason: s.reason == null ? null : str(s.reason, String(s.reason)),
      version: typeof s.version === 'string' ? s.version : null,
    },
  }
}

/**
 * Normalize GET /v1/devices. The engine returns both `devices` and `items`
 * aliases plus an optional `note` (present when the registry is empty). An
 * empty list with a note is a successful, readable response — not an error.
 * @param {unknown} data
 */
export function normalizeDevices(data) {
  const root = (data && typeof data === 'object') ? data : {}
  // The engine returns both `devices` and its `items` alias (same array); be
  // tolerant of either key being the populated one.
  const devices = Array.isArray(root.devices) ? root.devices : []
  const items = Array.isArray(root.items) ? root.items : []
  const list = devices.length >= items.length ? devices : items
  return {
    items: list.map(normalizeDevice),
    checkedAt: str(root.checkedAt, new Date().toISOString()),
    ephemeral: root.ephemeral !== false,
    note: typeof root.note === 'string' && root.note ? root.note : null,
  }
}

/** Normalize GET /v1/devices/{id}/tools into `{ tools }`. @param {unknown} data */
export function normalizeDeviceTools(data) {
  const root = (data && typeof data === 'object') ? data : {}
  const raw = Array.isArray(root.tools) ? root.tools : []
  const tools = raw
    .map((t) => ({
      name: str(t && t.name),
      description: (t && typeof t.description === 'string') ? t.description : undefined,
      inputSchema: (t && t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : undefined,
    }))
    .filter((t) => t.name.length > 0)
  return { tools }
}

/**
 * Normalize POST /v1/devices/{id}/action into a DeviceActionResult.
 * @param {unknown} data
 * @param {string} id
 * @param {string} tool
 */
export function normalizeDeviceAction(data, id, tool) {
  const root = (data && typeof data === 'object') ? data : {}
  let screenshot = null
  if (root.screenshot && typeof root.screenshot === 'object' && typeof root.screenshot.data === 'string') {
    screenshot = {
      mimeType: str(root.screenshot.mimeType, 'image/png'),
      data: root.screenshot.data,
    }
  }
  return {
    ok: root.ok !== false,
    device: str(root.device, id),
    tool: str(root.tool, tool),
    text: str(root.text),
    screenshot,
    at: str(root.at, new Date().toISOString()),
  }
}
