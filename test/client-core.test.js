import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ENGINE_URL,
  resolveEngineUrl,
  bearerValue,
  isExpired,
  enginePath,
  sessionFromStored,
  DEVICE_PATHS,
  engineCall,
  normalizeDevice,
  normalizeDevices,
  normalizeDeviceTools,
  normalizeDeviceAction,
} from '../src/client-core.js'

// These tests cover the pure client-core helpers that back the direct-engine
// client. The three old test files (worker.test.js, integrations.test.js,
// auth-flow.test.js) were removed with the Cloudflare Worker: they imported
// worker/lib.js, worker/integrations.js and worker/index.js, which no longer
// exist. The network helpers take an injected fetch so they can be exercised
// with a mock (no browser globals required).

// ---------------------------------------------------------------- mock fetch

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) }
}
function rawResponse(text, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => text }
}
function createFetch(handlers) {
  const calls = []
  let index = 0
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (index >= handlers.length) throw new Error('mock fetch: unexpected extra call')
    const handler = handlers[index++]
    if (handler instanceof Error) throw handler
    return handler
  }
  fn.calls = calls
  return fn
}

// ---------------------------------------------------------------- legacy helpers

test('resolveEngineUrl defaults to the production tunnel and strips trailing slashes', () => {
  assert.equal(resolveEngineUrl(undefined), DEFAULT_ENGINE_URL)
  assert.equal(DEFAULT_ENGINE_URL, 'https://aixodia.dpdns.org')
  assert.equal(resolveEngineUrl(''), DEFAULT_ENGINE_URL)
  assert.equal(resolveEngineUrl('   '), DEFAULT_ENGINE_URL)
  assert.equal(resolveEngineUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
  assert.equal(resolveEngineUrl('/engine'), '/engine')
})

test('bearerValue wraps the short-lived engine token', () => {
  assert.equal(bearerValue('opaque-token'), 'Bearer opaque-token')
})

test('isExpired treats past and invalid expiries as expired', () => {
  const now = 1_700_000_000_000
  assert.equal(isExpired(1_700_000_000, now), true) // exactly now -> expired
  assert.equal(isExpired(1_699_999_000, now), true) // in the past
  assert.equal(isExpired(1_700_000_900, now), false) // +900s (default TTL) -> valid
  assert.equal(isExpired(undefined, now), true)
  assert.equal(isExpired(NaN, now), true)
  assert.equal(isExpired('later', now), true)
})

test('enginePath maps legacy /api paths to direct engine paths', () => {
  assert.equal(enginePath('/api/health'), '/healthz')
  assert.equal(enginePath('/api/engine/status'), '/healthz')
  assert.equal(enginePath('/api/engine/v1/sessions'), '/v1/sessions')
  assert.equal(enginePath('/api/engine/v1/runs'), '/v1/runs')
  assert.equal(enginePath('/api/engine/v1/runs/run_x/events'), '/v1/runs/run_x/events')
  assert.equal(enginePath('/api/auth/token'), '/v1/auth/token')
})

test('sessionFromStored derives authenticated/user/expiresAt from token state', () => {
  const now = 1_700_000_000_000
  const stored = { token: 't', expiresAt: 1_700_000_900, user: 'Tulipskun', scope: 'client' }
  assert.deepEqual(sessionFromStored(stored, now), {
    authenticated: true,
    username: 'Tulipskun',
    expiresAt: new Date(1_700_000_900 * 1000).toISOString(),
  })
  assert.deepEqual(sessionFromStored(null, now), {
    authenticated: false, username: null, expiresAt: null,
  })
  assert.deepEqual(sessionFromStored({ ...stored, expiresAt: 1_700_000_000 }, now), {
    authenticated: false, username: null, expiresAt: null,
  })
})

// ---------------------------------------------------------------- device paths

test('DEVICE_PATHS point at the real engine endpoints and encode ids', () => {
  assert.equal(DEVICE_PATHS.list, '/v1/devices')
  assert.equal(DEVICE_PATHS.tools('redroid14'), '/v1/devices/redroid14/tools')
  assert.equal(DEVICE_PATHS.action('redroid14'), '/v1/devices/redroid14/action')
  assert.equal(DEVICE_PATHS.tools('a b/c'), '/v1/devices/a%20b%2Fc/tools')
  assert.equal(DEVICE_PATHS.action('a b/c'), '/v1/devices/a%20b%2Fc/action')
})

// ---------------------------------------------------------------- engineCall (mock fetch)

test('engineCall sends the Bearer token, method and JSON body and parses the response', async () => {
  const fetchFn = createFetch([jsonResponse({ tools: [{ name: 'tap' }] })])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.tools('dev-1'), {
    token: 'short-lived',
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { tools: [{ name: 'tap' }] })
  const call = fetchFn.calls[0]
  assert.equal(call.url, 'https://engine.test/v1/devices/dev-1/tools')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers['Authorization'], 'Bearer short-lived')
  assert.equal(call.init.credentials, 'omit')
})

test('engineCall sends the action body as { tool, arguments } for POST', async () => {
  const fetchFn = createFetch([jsonResponse({ ok: true, tool: 'tap', text: '' })])
  await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.action('dev-1'), {
    token: 'tok',
    method: 'POST',
    body: { tool: 'tap', arguments: { x: 10, y: 20 } },
  })
  const call = fetchFn.calls[0]
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(call.init.body), { tool: 'tap', arguments: { x: 10, y: 20 } })
})

test('engineCall returns NETWORK_ERROR on a transport failure', async () => {
  const fetchFn = createFetch([new Error('offline')])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.list)
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.equal(result.code, 'NETWORK_ERROR')
  assert.match(result.error, /Unable to connect to the engine/)
})

test('engineCall surfaces the engine error code and message on a non-2xx', async () => {
  const fetchFn = createFetch([jsonResponse({ error: 'Tool is not allowed', code: 'INVALID_TOOL' }, { ok: false, status: 400 })])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.action('dev-1'), { method: 'POST', body: {} })
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
  assert.equal(result.code, 'INVALID_TOOL')
  assert.equal(result.error, 'Tool is not allowed')
})

// ---------------------------------------------------------------- device normalizers

test('GET /v1/devices -> engineCall + normalizeDevices maps the engine list', async () => {
  const checkedAt = '2026-11-10T00:00:00Z'
  const devices = [
    { id: 'dev-a', name: 'dev-a', host: 'https://mcp/dev-a', status: { online: true, checkedAt, reason: null, version: '1.4', latencyMs: null } },
    { id: 'dev-b', name: 'dev-b', host: 'https://mcp/dev-b', status: { online: false, checkedAt, reason: 'MCP gateway unreachable', version: null, latencyMs: null } },
  ]
  const body = {
    devices,
    items: devices, // engine also sends an `items` alias (same array)
    checkedAt,
    ephemeral: true,
    source: 'kv:DEVICE_TUNNELS',
  }
  const fetchFn = createFetch([jsonResponse(body)])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.list)
  assert.equal(result.ok, true)
  const normalized = normalizeDevices(result.data)
  assert.equal(normalized.items.length, 2)
  assert.equal(normalized.items[0].id, 'dev-a')
  assert.equal(normalized.items[0].status.online, true)
  assert.equal(normalized.items[1].status.online, false)
  assert.equal(normalized.items[1].status.reason, 'MCP gateway unreachable')
  assert.equal(normalized.checkedAt, checkedAt)
  assert.equal(normalized.ephemeral, true)
  assert.equal(normalized.note, null)
})

test('empty device registry { devices: [], note } is a readable success, not an error', async () => {
  const note = 'No devices registered: Workers KV DEVICE_TUNNELS (and AIXODIA_DEVICE_TUNNELS) are empty, so the device list is intentionally empty rather than a 500.'
  const body = { devices: [], items: [], checkedAt: '2026-11-10T00:00:00Z', ephemeral: true, source: 'none', note }
  const fetchFn = createFetch([jsonResponse(body)])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.list)
  assert.equal(result.ok, true)
  const normalized = normalizeDevices(result.data)
  assert.deepEqual(normalized.items, [])
  assert.equal(normalized.note, note)
  assert.match(normalized.note, /intentionally empty/)
})

test('normalizeDevices prefers the items alias when devices is absent', () => {
  const normalized = normalizeDevices({ items: [{ id: 'x', name: 'X', host: 'h', status: { online: true, checkedAt: 't', reason: null } }] })
  assert.equal(normalized.items.length, 1)
  assert.equal(normalized.items[0].name, 'X')
})

test('normalizeDevice tolerates snake_case latency and missing fields', () => {
  const d = normalizeDevice({ id: 'd', name: 'D', host: '', status: { online: true, latency_ms: 42, checkedAt: 'now', reason: null } })
  assert.equal(d.status.latencyMs, 42)
  assert.equal(d.status.version, null)
})

test('GET /v1/devices/{id}/tools -> engineCall + normalizeDeviceTools', async () => {
  const body = { tools: [
    { name: 'tap', description: 'Tap the screen', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    { name: 'screenshot' },
    { description: 'no name, dropped' },
  ] }
  const fetchFn = createFetch([jsonResponse(body)])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.tools('dev-1'))
  assert.equal(result.ok, true)
  const normalized = normalizeDeviceTools(result.data)
  assert.equal(normalized.tools.length, 2)
  assert.equal(normalized.tools[0].name, 'tap')
  assert.equal(normalized.tools[0].description, 'Tap the screen')
  assert.equal(normalized.tools[0].inputSchema.properties.x.type, 'number')
  assert.equal(normalized.tools[1].name, 'screenshot')
})

test('POST /v1/devices/{id}/action -> engineCall + normalizeDeviceAction', async () => {
  const body = { ok: true, device: 'dev-1', tool: 'screenshot', text: '', screenshot: { mimeType: 'image/png', data: 'AAA' }, at: '2026-11-10T00:00:00Z' }
  const fetchFn = createFetch([jsonResponse(body)])
  const result = await engineCall(fetchFn, 'https://engine.test', DEVICE_PATHS.action('dev-1'), { method: 'POST', body: { tool: 'screenshot', arguments: {} } })
  assert.equal(result.ok, true)
  const normalized = normalizeDeviceAction(result.data, 'dev-1', 'screenshot')
  assert.equal(normalized.ok, true)
  assert.equal(normalized.device, 'dev-1')
  assert.equal(normalized.tool, 'screenshot')
  assert.deepEqual(normalized.screenshot, { mimeType: 'image/png', data: 'AAA' })
  assert.equal(normalized.at, '2026-11-10T00:00:00Z')
})

test('normalizeDeviceAction falls back to null screenshot and false ok', () => {
  const normalized = normalizeDeviceAction({ ok: false, text: 'Device action failed' }, 'dev-1', 'tap')
  assert.equal(normalized.ok, false)
  assert.equal(normalized.screenshot, null)
  assert.equal(normalized.device, 'dev-1')
  assert.equal(normalized.tool, 'tap')
})

test('normalizeDevices/normalizeDeviceTools never throw on null or malformed bodies', () => {
  assert.deepEqual(normalizeDevices(null).items, [])
  assert.deepEqual(normalizeDeviceTools(null).tools, [])
  assert.equal(normalizeDeviceAction(null, 'd', 't').ok, true)
  assert.equal(normalizeDevices(rawResponse('not json')).items.length, 0)
})
