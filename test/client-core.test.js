import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ENGINE_URL,
  resolveEngineUrl,
  bearerValue,
  isExpired,
  enginePath,
  mcpGatewayError,
  sessionFromStored,
} from '../src/client-core.js'

// These tests cover the pure client-core helpers that back the direct-engine
// client. The three old test files (worker.test.js, integrations.test.js,
// auth-flow.test.js) were removed with the Cloudflare Worker: they imported
// worker/lib.js, worker/integrations.js and worker/index.js, which no longer
// exist. This suite replaces them with tests for the new architecture.

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

test('mcpGatewayError returns a clear, recognizable not-migrated payload', () => {
  const e = mcpGatewayError('/api/devices')
  assert.equal(e.status, 501)
  assert.equal(e.code, 'MCP_GATEWAY_NOT_MIGRATED')
  assert.match(e.error, /not been migrated/i)
  assert.match(e.error, /no Worker service binding/i)
  assert.match(e.error, /\/api\/devices/)
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
