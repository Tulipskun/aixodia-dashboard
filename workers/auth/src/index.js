/**
 * AIxodia sign-in authority.
 *
 * Kept out of the engine on purpose. The engine is an agent that also exposes
 * device-control routes; making it the authority on who may use the console meant
 * its uptime was a login requirement, so upgrading it logged everyone out and a
 * crash locked the door.
 *
 * This Worker owns the allowlist and the session state in D1. It answers the
 * console whether or not the engine is running: a sign-in still succeeds when the
 * engine is down, and the console reports the engine as unreachable instead of
 * showing a login that appears broken.
 *
 * Storage choices, since they drive everything else here:
 *
 *   CONFIG (KV)    — the allowlist and Access values. Read constantly, written by
 *                    a human, so KV's eventual consistency costs nothing.
 *   DB (D1)        — sessions. A confirm must be visible to the next status poll,
 *                    and KV can take a minute to propagate a write, which would
 *                    make a confirmed session read as pending.
 */

const SESSION_PREFIX = ''
const PENDING_TTL_SECS = 60 * 60
const ACTIVE_TTL_SECS = 720 * 60 * 60
const EMAIL_MAX = 254

// ---------------------------------------------------------------- utilities

const encoder = new TextEncoder()

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function page(status, title, bodyHtml) {
  const escaped = String(title).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
      `<title>${escaped}</title>` +
      `<body style="font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#eee">` +
      `<div style="max-width:32rem;padding:1.5rem;text-align:center">` +
      `<h1 style="font-size:1.25rem">${escaped}</h1>${bodyHtml}</div></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** 32 random bytes, base64url. The token is the whole credential. */
function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** A reference only has to be unguessable enough to survive a race, not decades. */
function randomReference() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

function base64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Tokens are stored hashed.
 *
 * A D1 row is readable by anyone with the account credential, and a plaintext
 * token there is a live session for the taking. Hashing costs one digest per
 * request and makes a dump of the table useless.
 */
async function tokenKey(token) {
  return sha256Hex(SESSION_PREFIX + token)
}

/** Deliberately loose: the allowlist decides, this only rejects nonsense. */
function emailWellFormed(email) {
  const trimmed = String(email || '').trim()
  if (!trimmed || trimmed.length > EMAIL_MAX) return false
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (!local || !domain || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false
  }
  return !/[\s\u0000-\u001f\u007f]/.test(trimmed)
}

async function allowlist(env) {
  // KV first so an operator can change the list without a deploy; the var is the
  // fallback for a fresh deployment whose KV is not written yet.
  let raw = ''
  try {
    raw = (await env.CONFIG.get('auth/allowed_emails')) || ''
  } catch {
    // A KV read failure must not open the door; fall through to the var.
  }
  if (!raw.trim()) raw = env.AUTH_ALLOWED_EMAILS || ''
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'))
}

function permits(list, email) {
  const needle = String(email || '').trim().toLowerCase()
  return needle.length > 0 && list.includes(needle)
}

// ---------------------------------------------------------------- schema

/**
 * Creates the table once per isolate, not once per request.
 *
 * `IF NOT EXISTS` makes the statement harmless, but it is still a write sent to D1
 * on every status poll if it runs unconditionally. The schema cannot change while
 * this isolate lives, so remembering that it ran is enough.
 */
let schemaReady = null
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = createSchema(env).catch((err) => {
      // A failed create must be retried by the next request rather than cached as
      // done, or one transient D1 error would break the isolate for its lifetime.
      schemaReady = null
      throw err
    })
  }
  return schemaReady
}

async function createSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS gate_sessions (
       token_hash TEXT PRIMARY KEY NOT NULL,
       email TEXT NOT NULL,
       reference TEXT NOT NULL,
       state TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       confirm_by INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       confirmed_by TEXT
     )`,
  ).run()
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS gate_sessions_reference ON gate_sessions (reference)`,
  ).run()
}

/**
 * The state a row reports right now.
 *
 * Expiry is derived, never written. Sweeping on read would make every status poll
 * — which the app sends every couple of seconds — a D1 write, and a session table
 * that is written on read is the one pattern that turns a cheap poll into a
 * bottleneck. The stored state is what a human action set (pending, active,
 * revoked); whether it has run out of time is a function of the clock.
 */
function effectiveState(row) {
  if (!row) return 'unknown'
  if (row.state === 'pending') return row.confirm_by <= now() ? 'expired' : 'pending'
  if (row.state === 'active') return row.expires_at <= now() ? 'expired' : 'active'
  return row.state
}

const EXPLAIN = {
  EMAIL_NOT_ALLOWED: 'That email is not allowed to sign in.',
  BAD_EMAIL: 'That does not look like an email address.',
  NO_ALLOWLIST: 'This deployment has no allowed emails configured yet.',
}

// ---------------------------------------------------------------- handlers

async function request(env, req) {
  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_request', code: 'BAD_JSON' }, 400)
  }

  const email = String(body?.email || '').trim()
  if (!emailWellFormed(email)) {
    return json({ error: 'invalid_request', code: 'BAD_EMAIL' }, 400)
  }

  const list = await allowlist(env)
  if (list.length === 0) {
    // Distinct from "not on the list": this is a deployment mistake and saying so
    // saves an operator from debugging the client.
    return json({ error: 'not_configured', code: 'NO_ALLOWLIST' }, 503)
  }
  if (!permits(list, email)) {
    // Same answer as a malformed address: telling a stranger which it was would
    // let them enumerate the list.
    return json({ error: 'forbidden', code: 'EMAIL_NOT_ALLOWED' }, 403)
  }

  await ensureSchema(env)

  const token = randomToken()
  const reference = randomReference()
  const t = now()

  await env.DB.prepare(
    `INSERT INTO gate_sessions
       (token_hash, email, reference, state, created_at, confirm_by, expires_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`,
  )
    .bind(await tokenKey(token), email, reference, t, t + PENDING_TTL_SECS, t + ACTIVE_TTL_SECS)
    .run()

  return json({
    token,
    state: 'pending',
    reference,
    confirm_path: `/auth/confirm?reference=${reference}`,
    expires_at: t + ACTIVE_TTL_SECS,
  })
}

async function confirmPage(env, url) {
  const reference = (url.searchParams.get('reference') || '').trim()
  if (!reference) {
    return page(400, 'Missing confirmation code', '<p>Open the link from the app again.</p>')
  }

  await ensureSchema(env)

  const row = await env.DB.prepare(
    `SELECT email, state, confirm_by, expires_at FROM gate_sessions WHERE reference = ?1`,
  )
    .bind(reference)
    .first()

  if (!row) {
    return page(404, 'This link has expired', '<p>Return to the app and ask for a new link.</p>')
  }
  const state = effectiveState(row)
  if (state === 'active') {
    return page(200, 'Already confirmed', '<p>This session is active. Return to the app.</p>')
  }
  if (state !== 'pending') {
    return page(410, 'This link has expired', '<p>Return to the app and ask for a new link.</p>')
  }

  // A form POST, not a link: confirming must not happen because a browser
  // prefetched the page, and a POST is not replayed by a refresh the same way.
  return page(
    200,
    'Confirm sign-in',
    `<p>Confirm this session for <strong>${htmlEscape(row.email)}</strong>?</p>` +
      `<form method="post" action="/auth/confirm">` +
      `<input type="hidden" name="reference" value="${htmlEscape(reference)}">` +
      `<button type="submit" style="margin-top:1rem;padding:.75rem 1.5rem;border:0;` +
      `border-radius:.6rem;background:#7dd3fc;color:#0b1220;font:inherit;font-weight:600;` +
      `cursor:pointer">Confirm</button></form>`,
  )
}

async function confirmPost(env, req, url) {
  const contentType = req.headers.get('content-type') || ''
  let reference = ''
  if (contentType.includes('application/json')) {
    try {
      reference = String((await req.json())?.reference || '')
    } catch {
      reference = ''
    }
  } else {
    const form = await req.formData().catch(() => null)
    reference = String(form?.get('reference') || '')
  }
  reference = reference.trim()
  if (!reference) {
    return page(400, 'Missing confirmation code', '<p>Open the link from the app again.</p>')
  }

  await ensureSchema(env)

  // The Access JWT is what makes this proof of a login rather than proof of
  // holding a URL. Cloudflare sets it on every request it authorises.
  const subject = req.headers.get('cf-access-jwt-assertion') || ''
  if (!subject) {
    return page(401, 'Not signed in', '<p>Cloudflare Access did not authorise this request. Sign in again.</p>')
  }

  // One statement, so two simultaneous confirms cannot both succeed: the WHERE
  // clause only matches a row that is still pending.
  const t = now()
  const result = await env.DB.prepare(
    `UPDATE gate_sessions
        SET state = 'active', expires_at = ?2, confirmed_by = ?3
      WHERE reference = ?1 AND state = 'pending' AND confirm_by > ?4`,
  )
    .bind(reference, t + ACTIVE_TTL_SECS, subject.slice(0, 200), t)
    .run()

  if (result.meta.changes > 0) {
    return page(200, 'Confirmed', '<p>This session is now active. Return to the app.</p>')
  }

  const row = await env.DB.prepare(
    `SELECT state, confirm_by, expires_at FROM gate_sessions WHERE reference = ?1`,
  )
    .bind(reference)
    .first()
  if (effectiveState(row) === 'active') {
    return page(200, 'Already confirmed', '<p>This session is active. Return to the app.</p>')
  }
  return page(410, 'This link has expired', '<p>Return to the app and ask for a new link.</p>')
}

/**
 * Status of the caller's own token.
 *
 * Takes the token as a bearer credential, so it describes the caller's session and
 * nobody else's. A pending token is not an error: it exists and the app should
 * keep waiting.
 */
async function status(env, req) {
  const token = bearer(req)
  if (!token) {
    return json({ error: 'unauthorized', code: 'NO_TOKEN' }, 401)
  }

  await ensureSchema(env)

  const row = await env.DB.prepare(
    `SELECT state, email, expires_at, confirm_by FROM gate_sessions WHERE token_hash = ?1`,
  )
    .bind(await tokenKey(token))
    .first()

  if (!row) {
    return json({ error: 'unauthorized', code: 'UNKNOWN_TOKEN' }, 401)
  }
  const state = effectiveState(row)
  const deadline = state === 'pending' ? row.confirm_by : row.expires_at
  return json({ state, email: row.email, expires_at: deadline })
}

/**
 * What the engine asks: is this token valid, and for whom.
 *
 * The engine does not hold the token table and cannot check a signature, because
 * tokens are opaque. Asking here means revoking a session takes effect on both
 * sides at once.
 */
async function verify(env, req) {
  const token = bearer(req)
  if (!token) {
    return json({ error: 'unauthorized', code: 'NO_TOKEN' }, 401)
  }

  await ensureSchema(env)

  const row = await env.DB.prepare(
    `SELECT state, email, expires_at FROM gate_sessions WHERE token_hash = ?1`,
  )
    .bind(await tokenKey(token))
    .first()

  if (!row) return json({ valid: false, code: 'unknown_token' }, 401)
  const state = effectiveState(row)
  if (state === 'pending') return json({ valid: false, code: 'pending_confirmation' }, 403)
  if (state !== 'active') return json({ valid: false, code: 'expired' }, 401)
  return json({ valid: true, email: row.email, expires_at: row.expires_at })
}

function bearer(req) {
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

// ---------------------------------------------------------------- routing

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    // Cross-origin calls from the console need CORS; it is same-origin through the
    // Pages proxy, but keeping this means the Worker can be called directly too.
    const origin = req.headers.get('origin') || ''
    const cors = {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    let response
    try {
      if (method === 'POST' && path === '/auth/request') response = await request(env, req)
      else if (method === 'GET' && path === '/auth/confirm') response = await confirmPage(env, url)
      else if (method === 'POST' && path === '/auth/confirm') response = await confirmPost(env, req, url)
      else if (method === 'GET' && path === '/auth/status') response = await status(env, req)
      else if (method === 'POST' && path === '/auth/verify') response = await verify(env, req)
      else if (path === '/healthz') response = json({ ok: true })
      else response = json({ error: 'not_found' }, 404)
    } catch (err) {
      // A D1 outage must not read as a credential problem: the app would tell the
      // user their email was rejected.
      response = json({ error: 'server_error', code: 'STORAGE_FAILED', detail: String(err?.message || err) }, 500)
    }

    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v)
    return response
  },
}
