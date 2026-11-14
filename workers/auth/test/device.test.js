import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

// The device flow is stateful SQL, so these tests run it against a real SQLite
// database through a thin D1-shaped adapter over node:sqlite. That covers the
// statements themselves — not just their shape — including the unique user-code
// index and the single-delivery claim update.

import {
  deviceCode,
  devicePage,
  deviceApprove,
  deviceToken,
  revoke,
  activeSessions,
} from '../src/device.js'
import { hooks } from '../src/shared.js'

// Identity comes through the shared hook, so these tests substitute a stub
// instead of faking RSA signatures. Every test here runs as a signed-in
// approver unless it says otherwise.
let approverEmail = 'operator@example.com'
hooks.accessIdentity = async () =>
  approverEmail ? { email: approverEmail } : { error: 'no_assertion' }

// ---------------------------------------------------------------- D1 adapter

class D1Mini {
  constructor(db) {
    this.db = db
  }
  prepare(sql) {
    const db = this.db
    const params = []
    return {
      bind(...values) {
        params.push(...values)
        return this
      },
      async first() {
        return db.prepare(sql).get(...params) ?? null
      },
      async run() {
        const info = db.prepare(sql).run(...params)
        return { meta: { changes: info.changes } }
      },
      async all() {
        return { results: db.prepare(sql).all(...params) }
      },
    }
  }
  async batch(statements) {
    const results = []
    for (const statement of statements) results.push(await statement.run())
    return results
  }
}

const SCHEMA = `
CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL,
  device_name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT,
  token_hash TEXT
);
CREATE UNIQUE INDEX device_codes_user_code ON device_codes (user_code) WHERE state = 'pending';
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  device_name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending',
  revoked_at INTEGER
);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`

function setup({ secret = 'sync-secret' } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return {
    DB: new D1Mini(db),
    ENGINE_URL: '', // no push in tests; sync state stays 'pending'
    PUBLIC_URL: 'https://aixodia.dpdns.org',
    CONFIG: { get: async (key) => key === 'auth/sync_secret' ? secret : '' },
    AUTH_ALLOWED_EMAILS: approverEmail,
  }
}

function request({ method = 'POST', body, headers = {}, url = 'https://worker/auth/x' } = {}) {
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

async function createApprovedCode(env) {
  const created = await (await deviceCode(env, request({}))).json()
  const pageUrl = new URL(`https://worker/auth/device?code=${encodeURIComponent(created.device_code)}`)
  const page = await devicePage(env, request({ method: 'GET', url: pageUrl.href }), pageUrl)
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
  const approved = await deviceApprove(env, request({
    body: new URLSearchParams({ code: created.device_code, csrf }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }))
  assert.equal(approved.status, 200)
  return created
}

// ---------------------------------------------------------------- tests

test('device code issues the draft-shaped answer', async () => {
  const env = setup()
  const res = await deviceCode(env, request({ headers: { 'user-agent': 'AIxodiaAndroid/1.0' } }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.match(body.user_code, /^[A-Z]{4}-[0-9]{4}$/)
  assert.equal(body.interval, 5)
  assert.equal(body.expires_in, 600)
  assert.ok(body.device_code.length >= 40)
  assert.equal(body.verification_url, 'https://aixodia.dpdns.org/engine/auth/device')
})

test('approve requires the CSRF value the page minted', async () => {
  const env = setup()
  const created = await (await deviceCode(env, request({}))).json()

  const denied = await deviceApprove(env, request({
    body: new URLSearchParams({ code: created.device_code, csrf: 'forged' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }))
  assert.equal(denied.status, 403)

  const pageUrl = new URL(`https://worker/auth/device?code=${encodeURIComponent(created.device_code)}`)
  const page = await devicePage(env, request({ method: 'GET', url: pageUrl.href }), pageUrl)
  assert.equal(page.status, 200)
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)

  const ok = await deviceApprove(env, request({
    body: new URLSearchParams({ code: created.device_code, csrf }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }))
  assert.equal(ok.status, 200)
})

test('poll returns the token once and only once', async () => {
  const env = setup()
  const created = await createApprovedCode(env)

  const first = await (await deviceToken(env, request({ body: { device_code: created.device_code } }))).json()
  assert.equal(first.status, 'ok')
  assert.ok(first.access_token.length >= 40)

  const second = await (await deviceToken(env, request({ body: { device_code: created.device_code } }))).json()
  assert.equal(second.status, 'delivered')
  assert.equal(second.access_token, undefined)
})

test('an expired pending code reads as expired, not pending', async () => {
  const env = setup()
  const created = await (await deviceCode(env, request({}))).json()
  await env.DB.prepare(`UPDATE device_codes SET expires_at = 1`).run()
  const res = await deviceToken(env, request({ body: { device_code: created.device_code } }))
  assert.equal(res.status, 410)
  assert.equal((await res.json()).status, 'expired')
})

test('revoke by bearer kills the token and the poll answer turns revoked', async () => {
  const env = setup()
  const created = await createApprovedCode(env)
  const minted = await (await deviceToken(env, request({ body: { device_code: created.device_code } }))).json()

  const res = await revoke(env, request({
    headers: { authorization: `Bearer ${minted.access_token}` },
  }))
  assert.equal(res.status, 200)

  const after = await deviceToken(env, request({ body: { device_code: created.device_code } }))
  assert.equal(after.status, 401)
  assert.equal((await after.json()).status, 'revoked')
})

test('the engine pull answers hashes only and guards the secret', async () => {
  const env = setup()
  const created = await createApprovedCode(env)
  const minted = await (await deviceToken(env, request({ body: { device_code: created.device_code } }))).json()

  const denied = await activeSessions(env, request({ headers: { 'x-auth-sync': 'wrong' } }))
  assert.equal(denied.status, 403)

  const ok = await activeSessions(env, request({ headers: { 'x-auth-sync': 'sync-secret' } }))
  const body = await ok.json()
  assert.equal(body.hashes.length, 1)
  // The plaintext token must never appear in the sync answer.
  assert.ok(!JSON.stringify(body).includes(minted.access_token))
})

test('the poll endpoint rate limits per IP', async () => {
  const env = setup()
  let last = null
  for (let i = 0; i < 70; i++) {
    last = await deviceToken(env, request({
      body: { device_code: 'nonexistent' },
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    }))
  }
  assert.equal(last.status, 429)
})

test('a revoked approver is refused by the allowlist, not the signature', async () => {
  approverEmail = 'intruder@example.com'
  try {
    const env = setup()
    // The list is the operator's, not whoever happens to be signed in.
    env.AUTH_ALLOWED_EMAILS = 'operator@example.com'
    const created = await (await deviceCode(env, request({}))).json()
    const pageUrl = new URL(`https://worker/auth/device?code=${encodeURIComponent(created.device_code)}`)
    const page = await devicePage(env, request({ method: 'GET', url: pageUrl.href }), pageUrl)
    // The page itself only needs a signed-in browser; the allowlist gates approve.
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1]
    const denied = await deviceApprove(env, request({
      body: new URLSearchParams({ code: created.device_code, csrf }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }))
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, 'EMAIL_NOT_ALLOWED')
  } finally {
    approverEmail = 'operator@example.com'
  }
})
