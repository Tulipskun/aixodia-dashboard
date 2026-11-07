import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { validateTool, ToolValidationError, publicTools, TOOLS } from '../cloudflare/mcp-tools.js'
import {
  rpcCall,
  callTool,
  probeDevice,
  listTools,
  extractScreenshot,
  assertDeviceName,
  mcpConfig,
  mcpConfigured,
  McpError,
  PROTOCOL_VERSION,
  DEFAULT_MCP_BASE_URL,
} from '../cloudflare/mcp.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const DEV = 'redroid14-x86-64-c64742'
const allowed = new Set([DEV])
const env = {
  MCP_BASE_URL: 'https://mcp.example.test',
  CF_ACCESS_CLIENT_ID: 'cid-unit-test',
  CF_ACCESS_CLIENT_SECRET: 'csec-unit-test',
}

function rpcResponse(result, status = 200, contentType = 'application/json') {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status,
    headers: { 'content-type': contentType },
  })
}

// ---------- tool catalog / validation ----------

test('catalog has exactly the 8 DroidIME tools', () => {
  assert.equal(TOOLS.length, 8)
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ['tap', 'long_press', 'swipe', 'gesture', 'multi_touch', 'key_event', 'input_text', 'screenshot'],
  )
  assert.equal(publicTools().length, 8)
  assert.ok(publicTools().every((t) => Array.isArray(t.fields)))
})

test('validateTool: tap normalizes percent and drops unknown keys', () => {
  const out = validateTool('tap', { x: ' 50.50 % ', y: 25, evil: 'injected', __proto__: { x: '1%' } })
  assert.deepEqual(out, { name: 'tap', arguments: { x: '50.5%', y: '25%' } })
  assert.equal('evil' in out.arguments, false)
})

test('validateTool: percent bounds and format', () => {
  assert.throws(() => validateTool('tap', { x: '101%', y: '50%' }), ToolValidationError)
  assert.throws(() => validateTool('tap', { x: '50', y: '50%' }), ToolValidationError)
  assert.throws(() => validateTool('tap', { x: '-1%', y: '50%' }), ToolValidationError)
  assert.throws(() => validateTool('tap', { x: '50%', y: null }), ToolValidationError)
})

test('validateTool: swipe requires duration_ms (device uses getLong)', () => {
  assert.throws(
    () => validateTool('swipe', { x1: '10%', y1: '80%', x2: '90%', y2: '20%' }),
    ToolValidationError,
  )
  const ok = validateTool('swipe', { x1: '10%', y1: '80%', x2: '90%', y2: '20%', duration_ms: 400 })
  assert.equal(ok.arguments.duration_ms, 400)
})

test('validateTool: long_press defaults to 3000ms, min 200', () => {
  assert.equal(validateTool('long_press', { x: '50%', y: '50%' }).arguments.duration_ms, 3000)
  assert.throws(() => validateTool('long_press', { x: '50%', y: '50%', duration_ms: 10 }), ToolValidationError)
})

test('validateTool: key_event accepts keycode or keycodes[], needs one', () => {
  assert.deepEqual(validateTool('key_event', { keycode: 3 }).arguments, { keycode: 3, hold_ms: 0 })
  assert.deepEqual(validateTool('key_event', { keycodes: [113, 29] }).arguments, { keycodes: [113, 29], hold_ms: 0 })
  assert.throws(() => validateTool('key_event', {}), ToolValidationError)
  assert.throws(() => validateTool('key_event', { keycodes: [] }), ToolValidationError)
})

test('validateTool: input_text rejects control chars and >1000 chars', () => {
  assert.equal(validateTool('input_text', { text: 'สวัสดี ABC 123' }).arguments.text, 'สวัสดี ABC 123')
  assert.throws(() => validateTool('input_text', { text: 'a\u0000b' }), ToolValidationError)
  assert.throws(() => validateTool('input_text', { text: 'x'.repeat(1001) }), ToolValidationError)
})

test('validateTool: gesture / multi_touch nested arrays are bounded and rebuilt', () => {
  const g = validateTool('gesture', { points: [{ x: '50%', y: '80%', delay_ms: 0, hack: 1 }] })
  assert.deepEqual(g.arguments.points, [{ x: '50%', y: '80%', delay_ms: 0 }])
  assert.throws(() => validateTool('gesture', { points: Array(33).fill({ x: '1%', y: '1%', delay_ms: 0 }) }), ToolValidationError)
  assert.throws(() => validateTool('multi_touch', { pointers: Array(11).fill({ id: 0, points: [{ x: '1%', y: '1%', delay_ms: 0 }] }) }), ToolValidationError)
})

test('validateTool: unknown tool -> UNKNOWN_TOOL', () => {
  try {
    validateTool('rm_rf', {})
    assert.fail('should throw')
  } catch (err) {
    assert.equal(err.code, 'UNKNOWN_TOOL')
  }
})

// ---------- SSRF guard ----------

test('assertDeviceName: strict regex + allowlist', () => {
  assert.equal(assertDeviceName(DEV, allowed), DEV)
  for (const bad of ['../evil', 'EVIL', 'a b', '', 'x'.repeat(40), 'a.b', 'a/b', null]) {
    assert.throws(() => assertDeviceName(bad, allowed), McpError)
  }
  assert.throws(() => assertDeviceName('some-other-device', allowed), (e) => e.code === 'UNKNOWN_DEVICE')
})

test('mcpConfig: defaults and configured flag', () => {
  assert.equal(mcpConfig({}).baseUrl, DEFAULT_MCP_BASE_URL)
  assert.equal(mcpConfig({}).actionTimeoutMs, 8000)
  assert.equal(mcpConfigured(mcpConfig({})), false)
  assert.equal(mcpConfigured(mcpConfig(env)), true)
})

// ---------- outbound request hygiene ----------

test('rpcCall: fresh Headers, NO Origin/Cookie/Authorization/Referer, required headers present', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return rpcResponse({ supportedVersions: [PROTOCOL_VERSION] })
  }
  await rpcCall(DEV, 'server/discover', {}, env, { allowedDevices: allowed })

  const h = captured.init.headers
  assert.ok(h instanceof Headers)
  assert.equal(h.get('origin'), null)
  assert.equal(h.get('cookie'), null)
  assert.equal(h.get('authorization'), null)
  assert.equal(h.get('referer'), null)
  assert.equal(h.get('mcp-protocol-version'), PROTOCOL_VERSION)
  assert.equal(h.get('cf-access-client-id'), 'cid-unit-test')
  assert.equal(h.get('cf-access-client-secret'), 'csec-unit-test')
  assert.equal(h.get('content-type'), 'application/json')
  assert.equal(captured.url, `https://mcp.example.test/${DEV}`)
  assert.equal(captured.init.method, 'POST')
  const body = JSON.parse(captured.init.body)
  assert.equal(body.jsonrpc, '2.0')
  assert.equal(body.method, 'server/discover')
})

test('rpcCall: even a caller-supplied Origin header cannot leak upstream', async () => {
  let h
  globalThis.fetch = async (_url, init) => {
    h = init.headers
    return rpcResponse({ tools: [] })
  }
  // The proxy never receives the browser Request at all; simulate a hostile
  // env value that could otherwise be copied into headers.
  await rpcCall(DEV, 'tools/list', {}, { ...env, ORIGIN: 'https://evil.example' }, { allowedDevices: allowed })
  assert.equal(h.get('origin'), null)
})

// ---------- error normalization ----------

test('rpcCall: 502 HTML gateway page -> DEVICE_OFFLINE (not a 500 parse error)', async () => {
  globalThis.fetch = async () =>
    new Response('<!DOCTYPE html><html>...bad gateway...</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })
  await assert.rejects(
    () => rpcCall(DEV, 'server/discover', {}, env, { allowedDevices: allowed }),
    (err) => err instanceof McpError && err.code === 'DEVICE_OFFLINE' && err.status === 503,
  )
})

test('rpcCall: timeout -> DEVICE_TIMEOUT, network failure -> DEVICE_OFFLINE', async () => {
  globalThis.fetch = async () => {
    const e = new Error('timed out')
    e.name = 'TimeoutError'
    throw e
  }
  await assert.rejects(
    () => rpcCall(DEV, 'server/discover', {}, env, { allowedDevices: allowed }),
    (err) => err.code === 'DEVICE_TIMEOUT' && err.status === 504,
  )
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(
    () => rpcCall(DEV, 'server/discover', {}, env, { allowedDevices: allowed }),
    (err) => err.code === 'DEVICE_OFFLINE',
  )
})

test('rpcCall: JSON-RPC error object -> MCP_RPC_ERROR', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unsupported version' } }), {
      headers: { 'content-type': 'application/json' },
    })
  await assert.rejects(
    () => rpcCall(DEV, 'tools/list', {}, env, { allowedDevices: allowed }),
    (err) => err.code === 'MCP_RPC_ERROR',
  )
})

test('extractScreenshot: text + image separated, size cap enforced', () => {
  const { text, screenshot } = extractScreenshot({
    isError: false,
    content: [
      { type: 'text', text: 'tap completed' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  })
  assert.equal(text, 'tap completed')
  assert.deepEqual(screenshot, { mimeType: 'image/png', data: 'AAAA' })
  assert.equal(extractScreenshot({ content: [] }).screenshot, null)
  assert.throws(
    () => extractScreenshot({ content: [{ type: 'image', data: 'x'.repeat(9 * 1024 * 1024) }] }),
    McpError,
  )
})

test('callTool: isError result -> MCP_TOOL_ERROR; success -> ActionResult', async () => {
  globalThis.fetch = async () =>
    rpcResponse({ isError: true, content: [{ type: 'text', text: 'Shizuku not available' }] })
  await assert.rejects(
    () => callTool(DEV, 'tap', { x: '50%', y: '50%' }, env, allowed),
    (err) => err.code === 'MCP_TOOL_ERROR',
  )

  globalThis.fetch = async () =>
    rpcResponse({
      isError: false,
      content: [
        { type: 'text', text: 'tap completed' },
        { type: 'image', data: 'PNGDATA', mimeType: 'image/png' },
      ],
    })
  const result = await callTool(DEV, 'tap', { x: '50%', y: '50%' }, env, allowed)
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'tap')
  assert.equal(result.text, 'tap completed')
  assert.equal(result.screenshot.data, 'PNGDATA')
  assert.ok(result.durationMs >= 0)
})

test('probeDevice: never throws, always returns a status object', async () => {
  globalThis.fetch = async () => { throw new Error('down') }
  const s = await probeDevice(DEV, env, allowed)
  assert.equal(s.online, false)
  assert.equal(s.reason, 'offline')
  assert.ok(s.checkedAt)
})

test('listTools: normalizes tools/list shape', async () => {
  globalThis.fetch = async () =>
    rpcResponse({ tools: [{ name: 'tap', description: 'Tap', inputSchema: { type: 'object' } }] })
  const tools = await listTools(DEV, env, allowed)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'tap')
})
