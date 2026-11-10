// Pure, framework-agnostic helpers shared by the browser client (src/api.ts)
// and the Node test suite. Nothing here references browser globals directly:
// `fetch` is injected into the network helpers, and there is no import.meta.env
// / sessionStorage access, so `node --test` can import this module directly.

/** @typedef {{ token: string, expiresAt: number, refreshToken?: string, refreshExpiresAt?: number, user: string, scope: string }} StoredSession */
/** @typedef {{ authenticated: boolean, username: string | null, expiresAt: string | null }} ClientSession */

export const DEFAULT_ENGINE_URL = 'https://aixodia.dpdns.org'

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
 * Build the Bearer credential value for the short-lived engine token.
 * @param {string} token
 * @returns {string}
 */
export function bearerValue(token) {
  return `Bearer ${token}`
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
  if (legacyPath === '/api/auth/token') return '/v1/auth/token'
  if (legacyPath.startsWith('/api/engine/')) return legacyPath.slice('/api/engine'.length)
  if (legacyPath === '/api/engine') return '/'
  return legacyPath
}

/**
 * Build the public Session object from stored access/refresh credential state.
 * @param {StoredSession | null} stored
 * @param {number} [nowMs]
 * @returns {ClientSession}
 */
export function sessionFromStored(stored, nowMs = Date.now()) {
  if (!stored) return { authenticated: false, username: null, expiresAt: null }
  const accessExpired = isExpired(stored.expiresAt, nowMs)
  const refreshValid = typeof stored.refreshToken === 'string'
    && stored.refreshToken.length > 0
    && !isExpired(stored.refreshExpiresAt, nowMs)
  if (accessExpired && !refreshValid) {
    return { authenticated: false, username: null, expiresAt: null }
  }
  const effectiveExpiry = accessExpired ? stored.refreshExpiresAt : stored.expiresAt
  return {
    authenticated: true,
    username: stored.user || null,
    expiresAt: new Date(effectiveExpiry * 1000).toISOString(),
  }
}

// ---------------------------------------------------------------- devices
// The engine owns the device/MCP gateway routes directly (no Worker service
// binding). These paths are the real /v1/* endpoints; api.ts calls them with
// the same short-lived Bearer token used for every other engine route.

export const DEVICE_PATHS = {
  list: '/v1/devices',
  tools: (id) => `/v1/devices/${encodeURIComponent(id)}/tools`,
  action: (id) => `/v1/devices/${encodeURIComponent(id)}/action`,
}

/**
 * One engine call with the short-lived token. Returns a discriminated result
 * instead of throwing so it stays easy to unit-test with a mock fetch. `api.ts`
 * turns a failure into an ApiError and handles 401 locally.
 *
 * @param {(url: string, init: object) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} fetchFn
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ token?: string, method?: string, body?: unknown }} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: unknown, error?: string, code?: string }>}
 */
export async function engineCall(fetchFn, baseUrl, path, options = {}) {
  const headers = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers['Authorization'] = bearerValue(options.token)
  let res
  try {
    res = await fetchFn(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      credentials: 'omit',
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

/**
 * Refresh an Engine access token. This pure helper keeps the HTTP contract
 * injectable so success, expiry, rejection and network failures are testable.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {string} refreshToken
 * @param {number} [nowMs]
 */
export async function refreshEngineSession(fetchFn, baseUrl, refreshToken, nowMs = Date.now()) {
  const result = await engineCall(fetchFn, baseUrl, '/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  })
  if (!result.ok) return result
  const payload = (result.data && typeof result.data === 'object') ? result.data : {}
  if (typeof payload.token !== 'string' || !payload.token
      || typeof payload.expires_at !== 'number' || !Number.isFinite(payload.expires_at)
      || typeof payload.refresh_token !== 'string' || !payload.refresh_token
      || typeof payload.refresh_expires_at !== 'number' || !Number.isFinite(payload.refresh_expires_at)) {
    return {
      ok: false,
      status: result.status,
      code: 'INVALID_TOKEN_RESPONSE',
      error: 'The engine returned an invalid refresh response.',
      data: result.data,
    }
  }
  if (isExpired(payload.expires_at, nowMs) || isExpired(payload.refresh_expires_at, nowMs)) {
    return {
      ok: false,
      status: result.status,
      code: 'INVALID_TOKEN_RESPONSE',
      error: 'The engine returned expired refresh credentials.',
      data: result.data,
    }
  }
  return {
    ok: true,
    status: result.status,
    session: {
      token: payload.token,
      expiresAt: payload.expires_at,
      refreshToken: payload.refresh_token,
      refreshExpiresAt: payload.refresh_expires_at,
      user: typeof payload.user === 'string' ? payload.user : '',
      scope: typeof payload.scope === 'string' ? payload.scope : 'client',
    },
  }
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

// ---------------------------------------------------------------- GitHub Device Flow
// A second, fully working sign-in method (enabled when VITE_GITHUB_CLIENT_ID is
// set). The whole flow is pure: `fetch` is injected so node --test can drive the
// state machine with a mock. The resulting GitHub OAuth access token is handed
// to the engine's /v1/auth/token by api.ts, exactly like a pasted PAT, and only
// the engine's short-lived token is ever kept in the browser.

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const GITHUB_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const DEVICE_FLOW_SCOPE = 'read:user'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** GitHub answers either JSON or form-urlencoded; accept both. @param {string} text */
export function parseOAuth(text) {
  if (!text || typeof text !== 'string') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* fall through to form-encoded */ }
  const out = {}
  try {
    for (const [key, value] of new URLSearchParams(text)) out[key] = value
  } catch { /* ignore malformed bodies */ }
  return out
}

/** @param {string} code @param {string} message */
export function deviceFlowError(code, message) {
  const err = new Error(message)
  err.name = 'DeviceFlowError'
  err.code = code
  return err
}

/** Map GitHub device-flow error codes to messages a person can act on. */
export function readableGitHubError(error, description) {
  if (typeof description === 'string' && description) return description
  switch (error) {
    case 'expired_token': return 'The sign-in code has expired. Please start again.'
    case 'access_denied': return 'Sign-in was declined or cancelled in GitHub.'
    case 'incorrect_device_code': return 'GitHub rejected the device code. Please start again.'
    case 'incorrect_client_credentials': return 'The GitHub OAuth app client id is invalid. Check VITE_GITHUB_CLIENT_ID.'
    case 'bad_verification_code': return 'The verification code was rejected. Please start again.'
    case 'unsupported_grant_type': return 'GitHub rejected the device-flow grant type.'
    case 'slow_down': return 'Too many sign-in attempts; waiting a bit longer.'
    case 'authorization_pending': return 'Waiting for authorization in GitHub…'
    case 'NETWORK_ERROR': return 'Unable to contact GitHub to complete sign-in.'
    default: return error ? `GitHub could not complete sign-in (${error}).` : 'GitHub could not complete sign-in.'
  }
}

/**
 * Step 1: ask GitHub for a device code. `onCode` is NOT called here — api.ts
 * receives the returned DeviceCodeInfo, shows `userCode` + `verificationUri` in
 * the UI, then polls with pollDeviceFlow().
 * @param {typeof fetch} fetchFn
 * @param {string} clientId
 * @param {string} [scope]
 */
export async function requestDeviceCode(fetchFn, clientId, scope = DEVICE_FLOW_SCOPE) {
  let res
  try {
    res = await fetchFn(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope }),
    })
  } catch {
    throw deviceFlowError('NETWORK_ERROR', 'Unable to contact GitHub to start sign-in.')
  }
  const data = parseOAuth(typeof res.text === 'function' ? await res.text() : '')
  if (!res.ok) {
    throw deviceFlowError(data.error || 'HTTP_ERROR', readableGitHubError(data.error, data.error_description))
  }
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw deviceFlowError('INVALID_DEVICE_CODE_RESPONSE', 'GitHub returned an incomplete device code response.')
  }
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 900,
    interval: Number(data.interval) > 0 ? Number(data.interval) : 5,
  }
}

/** Abort-aware sleep so the wait between polls can be cancelled immediately. */
function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      reject(deviceFlowError('DEVICE_FLOW_CANCELLED', 'Sign-in was cancelled.'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(deviceFlowError('DEVICE_FLOW_CANCELLED', 'Sign-in was cancelled.'))
    }, { once: true })
  })
}

/**
 * Step 2: poll until GitHub returns an access_token. Handles the documented
 * state machine: authorization_pending -> keep waiting, slow_down -> lengthen
 * the interval, expired_token / access_denied / incorrect_device_code -> a
 * readable terminal error. `wait` and `now` are injectable for deterministic
 * tests; `signal` lets the UI cancel.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {{ interval?: number, expiresIn?: number, signal?: AbortSignal, now?: () => number, wait?: (ms: number, signal?: AbortSignal) => Promise<void> }} [options]
 * @returns {Promise<string>} the GitHub OAuth access token
 */
export async function pollDeviceFlow(fetchFn, clientId, deviceCode, options = {}) {
  let interval = Number(options.interval) > 0 ? Number(options.interval) : 5
  const expiresIn = Number(options.expiresIn) > 0 ? Number(options.expiresIn) : 900
  const now = options.now || Date.now
  const wait = options.wait || abortableWait
  const deadline = now() + expiresIn * 1000
  while (true) {
    if (options.signal?.aborted) {
      throw deviceFlowError('DEVICE_FLOW_CANCELLED', 'Sign-in was cancelled.')
    }
    if (now() >= deadline) {
      throw deviceFlowError('expired_token', 'The sign-in code has expired. Please start again.')
    }
    let res
    try {
      res = await fetchFn(GITHUB_DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }),
      })
    } catch {
      throw deviceFlowError('NETWORK_ERROR', 'Unable to contact GitHub to complete sign-in.')
    }
    const data = parseOAuth(typeof res.text === 'function' ? await res.text() : '')
    if (typeof data.access_token === 'string' && data.access_token) {
      return data.access_token
    }
    switch (data.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        interval += 5
        break
      case 'expired_token':
        throw deviceFlowError('expired_token', 'The sign-in code has expired. Please start again.')
      case 'access_denied':
        throw deviceFlowError('access_denied', 'Sign-in was declined or cancelled in GitHub.')
      case 'incorrect_device_code':
        throw deviceFlowError('incorrect_device_code', 'GitHub rejected the device code. Please start again.')
      default: {
        const detail = !data.error ? ` (HTTP ${res.status})` : ''
        throw deviceFlowError(
          data.error || 'HTTP_ERROR',
          `${readableGitHubError(data.error, data.error_description)}${detail}`,
        )
      }
    }
    await wait(interval * 1000, options.signal)
  }
}
