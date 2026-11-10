// Pure, framework-agnostic helpers shared by the browser client (src/api.ts)
// and the Node test suite. Nothing here touches browser globals (fetch,
// sessionStorage, import.meta.env), so `node --test` can import this module
// directly with no TypeScript stripping or DOM stubs.

/** @typedef {{ token: string, expiresAt: number, user: string, scope: string }} StoredSession */
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
 * Error payload for device/MCP gateway calls not yet migrated to the engine.
 * api.ts turns this into an ApiError so callers get a clear, readable message.
 * @param {string} feature
 * @returns {{ status: number, code: string, error: string }}
 */
export function mcpGatewayError(feature) {
  return {
    status: 501,
    code: 'MCP_GATEWAY_NOT_MIGRATED',
    error: `Device/MCP gateway has not been migrated to the engine yet (${feature}). The dashboard now talks to the engine directly and there is no Worker service binding to reach DroidIME devices.`,
  }
}

/**
 * Build the public Session object from stored short-lived-token state.
 * @param {StoredSession | null} stored
 * @param {number} [nowMs]
 * @returns {ClientSession}
 */
export function sessionFromStored(stored, nowMs = Date.now()) {
  if (!stored || isExpired(stored.expiresAt, nowMs)) {
    return { authenticated: false, username: null, expiresAt: null }
  }
  return {
    authenticated: true,
    username: stored.user || null,
    expiresAt: new Date(stored.expiresAt * 1000).toISOString(),
  }
}
