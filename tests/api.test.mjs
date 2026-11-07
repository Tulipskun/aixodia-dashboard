import test, { before, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { handleApi } from '../cloudflare/api.js'
import { PROTOCOL_VERSION } from '../cloudflare/mcp.js'
import {
  ORIGIN,
  USERNAME,
  PASSWORD,
  testEnv,
  apiRequest,
  loginCookie,
  offlineFetch,
  reset,
} from './helpers.mjs'
import { startStub, PNG_BASE64 } from './fixtures/mcp-stub.mjs'

const realFetch = globalThis.fetch
const DEV = 'redroid14-x86-64-c64742'

let env
let cookie

before(async () => {
  env = await testEnv()
})

afterEach(() => {
  globalThis.fetch = realFetch
  reset()
})

async function call(path, opts = {}) {
  return handleApi(apiRequest(path, opts), env, {})
}

function okFetch(result = {}) {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      headers: { 'content-type': 'application/json' },
    })
}

// ---------- public routes ----------

test('GET /api/health: 200, no upstream call, no secrets', async () => {
  let upstreamCalls = 0
  globalThis.fetch = async () => { upstreamCalls += 1; return okFetch()() }
  const res = await call('/api/health')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.protocolVersion, PROTOCOL_VERSION)
  assert.equal(body.deviceCount, 1)
  assert.equal(body.authConfigured, true)
  assert.equal(body.mcpConfigured, true)
  assert.equal(upstreamCalls, 0)
  const raw = JSON.stringify(body)
  for (const secret of ['SESSION_SECRET', 'AUTH_PASSWORD_HASH', 'CF_ACCESS_CLIENT_SECRET', 'csec-unit-test']) {
    assert.equal(raw.includes(secret), false)
  }
})

test('OPTIONS /api/* -> 204 without auth', async () => {
  const res = await handleApi(new Request(`${ORIGIN}/api/devices`, { method: 'OPTIONS' }), env, {})
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

// ---------- auth gate ----------

test('unauthenticated request -> 401 AUTH_REQUIRED and NEVER touches MCP', async () => {
  let upstreamCalls = 0
  globalThis.fetch = async () => { upstreamCalls += 1; return okFetch()() }
  const res = await call('/api/devices')
  assert.equal(res.status, 401)
  assert.equal((await res.json()).code, 'AUTH_REQUIRED')
  assert.equal(upstreamCalls, 0)
})

test('POST /api/login: 200 + signed cookie (HttpOnly/Secure/SameSite), no secret in body', async () => {
  globalThis.fetch = offlineFetch
  const res = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
  assert.equal(res.status, 200)
  const setCookie = res.headers.get('set-cookie')
  assert.match(setCookie, /axd_session=[^;]+\.[^;]+/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /Secure/)       // https URL in tests
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Path=\//)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.username, USERNAME)
  assert.equal(JSON.stringify(body).includes('AUTH_PASSWORD_HASH'), false)
  cookie = setCookie.split(';')[0]
})

test('login: identical error for wrong username and wrong password', async () => {
  globalThis.fetch = offlineFetch
  const a = await call('/api/login', { method: 'POST', body: { username: 'nobody', password: PASSWORD } })
  const b = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: 'nope' } })
  assert.equal(a.status, 401)
  assert.equal(b.status, 401)
  const bodyA = await a.json()
  const bodyB = await b.json()
  assert.equal(bodyA.error, bodyB.error)
  assert.equal(bodyA.code, 'INVALID_CREDENTIALS')
})

test('login: CSRF rejects cross-origin and non-JSON POST', async () => {
  globalThis.fetch = offlineFetch
  const cross = await handleApi(
    apiRequest('/api/login', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { username: USERNAME, password: PASSWORD },
    }),
    env,
    {},
  )
  assert.equal(cross.status, 403)
  assert.equal((await cross.json()).code, 'CSRF_REJECTED')

  const form = await handleApi(
    apiRequest('/api/login', {
      method: 'POST',
      contentType: 'text/plain',
      body: 'username=admin',
    }),
    env,
    {},
  )
  assert.equal(form.status, 403)
})

test('login: rate limit after 5 failures -> 429 + Retry-After', async () => {
  globalThis.fetch = offlineFetch
  for (let i = 0; i < 5; i++) {
    const r = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: 'wrong' } })
    assert.equal(r.status, 401)
  }
  const blocked = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
  assert.equal(blocked.status, 429)
  assert.equal((await blocked.json()).code, 'RATE_LIMITED')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
})

test('GET /api/session: authenticated payload contains no secret', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/session', { cookie: c })
  const body = await res.json()
  assert.equal(body.authenticated, true)
  assert.equal(body.username, USERNAME)
  assert.ok(body.expiresAt)
  for (const secret of ['SESSION_SECRET', 'AUTH_PASSWORD_HASH', 'CF_ACCESS_CLIENT_SECRET', 'unit-test-session-secret']) {
    assert.equal(JSON.stringify(body).includes(secret), false)
  }
})

// ---------- config / tools / status / offline ----------

test('GET /api/config: new schema, no GitHub dashboard keys', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/config', { cookie: c })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.console.name, 'AIxodia Device Console')
  assert.equal(body.devices.length, 1)
  assert.equal(body.devices[0].id, DEV)
  assert.equal(body.presets.length, 5)
  const raw = JSON.stringify(body)
  for (const legacy of ['"apps"', '"repo"', 'highlights', 'stars', 'workflow_runs']) {
    assert.equal(raw.includes(legacy), false)
  }
})

test('GET /api/tools: 8 descriptors, source catalog when offline', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/tools', { cookie: c })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.tools.length, 8)
  assert.equal(body.source, 'catalog')
  assert.equal(body.protocolVersion, PROTOCOL_VERSION)
})

test('GET /api/devices/:id/status: ALWAYS 200 with online:false when offline', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call(`/api/devices/${DEV}/status`, { cookie: c })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.online, false)
  assert.equal(body.reason, 'offline')
  assert.ok(body.checkedAt)
})

test('GET /api/devices: list includes status, no 500 when offline', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/devices', { cookie: c })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.items.length, 1)
  assert.equal(body.items[0].status.online, false)
  assert.equal(body.ephemeral, true)
})

test('POST action offline -> 503 DEVICE_OFFLINE (not a generic 500)', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call(`/api/devices/${DEV}/action`, {
    method: 'POST',
    cookie: c,
    body: { tool: 'tap', arguments: { x: '50%', y: '50%' } },
  })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.code, 'DEVICE_OFFLINE')
  assert.equal(body.reason, 'offline')
  assert.ok(body.requestId)
})

test('unknown tool / bad args are rejected BEFORE any upstream fetch', async () => {
  let upstreamCalls = 0
  globalThis.fetch = async () => { upstreamCalls += 1; return okFetch()() }
  const c = await loginCookie(env)

  const unknown = await call(`/api/devices/${DEV}/action`, {
    method: 'POST', cookie: c, body: { tool: 'evil', arguments: {} },
  })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).code, 'UNKNOWN_TOOL')

  const badArgs = await call(`/api/devices/${DEV}/action`, {
    method: 'POST', cookie: c, body: { tool: 'tap', arguments: { x: '999%', y: '50%' } },
  })
  assert.equal(badArgs.status, 400)
  assert.equal((await badArgs.json()).code, 'INVALID_ARGUMENTS')
  assert.equal(upstreamCalls, 0)
})

test('unknown device -> 404 UNKNOWN_DEVICE', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/devices/not-in-allowlist/status', { cookie: c })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'UNKNOWN_DEVICE')
})

// ---------- legacy GitHub routes are gone ----------

test('old GitHub dashboard routes -> 404 UNKNOWN_ROUTE', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  for (const [path, method, body] of [
    ['/api/apps', 'GET', undefined],
    ['/api/overview', 'GET', undefined],
    ['/api/snapshot/droidime', 'GET', undefined],
    ['/api/refresh', 'POST', {}],
  ]) {
    const res = await call(path, { method, cookie: c, body })
    assert.equal(res.status, 404, `${path} should be gone`)
    assert.equal((await res.json()).code, 'UNKNOWN_ROUTE')
  }
})

// ---------- body / cookies / headers ----------

test('readJsonBody: invalid JSON -> 400, oversized body -> 413', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const bad = await call(`/api/devices/${DEV}/action`, {
    method: 'POST', cookie: c, body: '{not json',
  })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'INVALID_JSON')

  const huge = await call(`/api/devices/${DEV}/action`, {
    method: 'POST', cookie: c, body: JSON.stringify({ tool: 'input_text', arguments: { text: 'x'.repeat(70_000) } }),
  })
  assert.equal(huge.status, 413)
  assert.equal((await huge.json()).code, 'BODY_TOO_LARGE')
})

test('POST /api/logout clears the cookie; session becomes unauthenticated', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/logout', { method: 'POST', cookie: c, body: {} })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/)
  const cleared = res.headers.get('set-cookie').split(';')[0]
  const after = await call('/api/session', { cookie: cleared })
  assert.equal((await after.json()).authenticated, false)
})

test('every API response carries Cache-Control: no-store', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const responses = await Promise.all([
    call('/api/health'),
    call('/api/devices'),
    call('/api/session', { cookie: c }),
    call('/api/config', { cookie: c }),
    call('/api/tools', { cookie: c }),
    call(`/api/devices/${DEV}/status`, { cookie: c }),
    call(`/api/devices/${DEV}/action`, { method: 'POST', cookie: c, body: { tool: 'screenshot', arguments: {} } }),
    call('/api/commands', { cookie: c }),
    call('/api/nope', { cookie: c }),
  ])
  for (const r of responses) assert.equal(r.headers.get('cache-control'), 'no-store')
})

test('GET /api/commands: ephemeral ring buffer, metadata only (no base64)', async () => {
  globalThis.fetch = offlineFetch
  const c = await loginCookie(env)
  const res = await call('/api/commands', { cookie: c })
  const body = await res.json()
  assert.equal(body.ephemeral, true)
  assert.ok(Array.isArray(body.items))
  assert.equal(JSON.stringify(body).includes('base64'), false)
})

// ---------- E2E against a healthy local MCP stub ----------

test('E2E stub: device online, action returns screenshot, tools source=device, no Origin leaked', async () => {
  const stub = await startStub()
  try {
    globalThis.fetch = realFetch
    const stubEnv = await testEnv({ MCP_BASE_URL: stub.url })
    const c = await loginCookie(stubEnv)
    const H = (path, opts = {}) => handleApi(apiRequest(path, opts), stubEnv, {})

    const status = await H(`/api/devices/${DEV}/status`, { cookie: c })
    assert.equal(status.status, 200)
    assert.equal((await status.json()).online, true)

    const action = await H(`/api/devices/${DEV}/action`, {
      method: 'POST', cookie: c, body: { tool: 'tap', arguments: { x: '50%', y: '25%' } },
    })
    assert.equal(action.status, 200)
    const result = await action.json()
    assert.equal(result.ok, true)
    assert.equal(result.tool, 'tap')
    assert.equal(result.text, 'tap completed')
    assert.equal(result.screenshot.mimeType, 'image/png')
    assert.equal(result.screenshot.data, PNG_BASE64)
    assert.ok(result.requestId)

    const tools = await H('/api/tools', { cookie: c })
    assert.equal((await tools.json()).source, 'device')

    const commands = await H('/api/commands', { cookie: c })
    const log = await commands.json()
    assert.equal(log.items.length, 1)
    assert.equal(log.items[0].tool, 'tap')
    assert.equal(log.items[0].hasScreenshot, true)
    assert.equal(JSON.stringify(log).includes(PNG_BASE64), false)

    // The stub enforces the real device's 403-on-Origin rule.
    assert.ok(stub.seen.length >= 3)
    for (const seen of stub.seen) assert.equal(seen.headers.origin, undefined)
  } finally {
    await stub.close()
  }
})
