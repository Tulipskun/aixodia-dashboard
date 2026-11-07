// Shared helpers for the console API unit tests.
import { derivePasswordHash } from '../cloudflare/auth.js'
import { handleApi, resetApiState } from '../cloudflare/api.js'

export const ORIGIN = 'https://console.example'
export const USERNAME = 'admin'
export const PASSWORD = 'test-password-123'

export async function testEnv(overrides = {}) {
  return {
    SESSION_SECRET: 'unit-test-session-secret-0123456789',
    AUTH_USERNAME: USERNAME,
    AUTH_PASSWORD_HASH: await derivePasswordHash(PASSWORD),
    CF_ACCESS_CLIENT_ID: 'cid-unit-test',
    CF_ACCESS_CLIENT_SECRET: 'csec-unit-test',
    MCP_BASE_URL: 'https://mcp.example.test',
    __PLATFORM: 'unit-test',
    ...overrides,
  }
}

export function apiRequest(path, opts = {}) {
  const {
    method = 'GET',
    body,
    cookie,
    origin = ORIGIN,
    contentType = 'application/json',
    headers = {},
  } = opts
  const h = new Headers(headers)
  if (method === 'POST') {
    if (origin !== null) h.set('origin', origin)
    if (contentType) h.set('content-type', contentType)
  }
  if (cookie) h.set('cookie', cookie)
  const init = { method, headers: h }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`${ORIGIN}${path}`, init)
}

export async function loginCookie(env) {
  const res = await handleApi(
    apiRequest('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } }),
    env,
    {},
  )
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${await res.text()}`)
  return res.headers.get('set-cookie').split(';')[0]
}

export function authed(req, cookie, extra = {}) {
  const h = new Headers(req.headers)
  if (cookie) h.set('cookie', cookie)
  return new Request(req.url, { method: req.method, headers: h, body: req.body, duplex: 'half' })
}

// A fetch that behaves like a device/gateway that is down.
export const offlineFetch = async () => {
  throw new Error('network unreachable (unit test)')
}

export function reset() {
  resetApiState()
}
