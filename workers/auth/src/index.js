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
 *   DB (D1)        — sessions. A token must be readable the moment it is issued,
 *                    and KV can take a minute to propagate a write, so a session
 *                    could be refused right after being created.
 */

const SESSION_PREFIX = ''
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

/**
 * Reads the signed-in identity from the Access assertion.
 *
 * The email is taken from a JWT Cloudflare signed, not from the request body. That
 * is the difference between "this browser says it is someone" and "Cloudflare
 * verified this session": a body field can be any string a script sends, while the
 * assertion is issued only after a real login and is bound to this application's
 * audience.
 *
 * The signature is checked against the team's published keys. Reading the claims
 * without verifying them would accept a token this Worker can be handed by anyone,
 * which the email field already allowed.
 */
async function accessIdentity(env, req) {
  // The header is what an Access-protected origin receives. The cookie is the same
  // assertion held by the browser: it is sent here because this Worker sits on its
  // own hostname, which Access does not protect and therefore does not annotate.
  // Both carry a token signed by the same team key, so the checks below are what
  // make either one trustworthy.
  const assertion =
    req.headers.get('cf-access-jwt-assertion') || accessJwtFromCookies(req.headers.get('cookie') || '')
  if (!assertion) return { error: 'no_assertion' }

  const parts = assertion.split('.')
  if (parts.length !== 3) return { error: 'malformed' }

  let header
  let claims
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])))
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
  } catch {
    return { error: 'malformed' }
  }

  const teamDomain = (await configValue(env, 'access/team_domain', 'ACCESS_TEAM_DOMAIN')).trim()
  const audience = (await configValue(env, 'access/app_aud', 'ACCESS_APP_AUD')).trim()
  if (!teamDomain || !audience) return { error: 'not_configured' }

  const verified = await verifySignature(assertion, header, teamDomain)
  if (!verified) return { error: 'bad_signature' }

  // The assertion carries the audience of the Access application that issued it, and
  // several protect this product: the console origin and the engine's own hostname
  // are separate applications with separate tags. Accepting only one would refuse a
  // browser that signed in through the other, which is what made every console
  // sign-in fail while curl against the engine looked fine.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const accepted = (env.ACCESS_ACCEPTED_AUDIENCES || audience)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (!audiences.some((tag) => accepted.includes(tag))) return { error: 'wrong_audience' }
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return { error: 'expired' }

  const email = String(claims.email || claims.sub || '').trim()
  if (!email) return { error: 'no_subject' }
  return { email }
}

/** Checks an RS256 signature against the team's current key set. */
async function verifySignature(assertion, header, teamDomain) {
  const kid = header.kid
  if (!kid) return false

  let keys
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cache: 'no-store' })
    if (!res.ok) return false
    keys = (await res.json()).keys || []
  } catch {
    return false
  }

  const jwk = keys.find((key) => key.kid === kid)
  if (!jwk) return false

  let key
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    return false
  }

  const [rawHeader, rawPayload, rawSignature] = assertion.split('.')
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  try {
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64urlDecode(rawSignature),
      signed,
    )
  } catch {
    return false
  }
}

/**
 * Who the browser is signed in as, or 401.
 *
 * Separate from `/auth/request` because it creates nothing: the console calls this
 * on load to decide whether to show the app or the sign-in panel, and it has to be
 * answerable without the engine and without writing a session just to ask.
 */
async function identity(env, req) {
  const found = await accessIdentity(env, req)
  if (!found.email) {
    return json({ error: 'unauthorized', code: found.error?.toUpperCase() || 'NO_ACCESS_SESSION' }, 401)
  }
  return json({ email: found.email })
}

/** Pulls the Access assertion out of the browser's cookie header. */
function accessJwtFromCookies(cookieHeader) {
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== 'CF_Authorization') continue
    const value = part.slice(index + 1).trim()
    return value ? decodeURIComponent(value) : ''
  }
  return ''
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function configValue(env, kvKey, varName) {
  try {
    const fromKv = await env.CONFIG.get(kvKey)
    if (fromKv && fromKv.trim()) return fromKv
  } catch {
    // A KV failure must fall through to the variable, not open the door.
  }
  return env[varName] || ''
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
      if (method === 'POST' && path === '/auth/verify') response = await verify(env, req)
      else if (path === '/healthz') response = json({ ok: true })
      else if (method === 'GET' && path === '/auth/identity') response = await identity(env, req)
      else if (method === 'GET' && path === '/auth/start') {
        // The place Cloudflare Access intercepts. A browser sent here without a
        // session is redirected to the login and comes back with one; with a
        // session it lands here, so answering 204 gives it nothing to parse and
        // nothing to get stuck on.
        response = new Response(null, { status: 204 })
      }

      else response = json({ error: 'not_found' }, 404)
    } catch (err) {
      // A D1 outage must not read as a credential problem: the app would tell the
      // user their account was rejected.
      response = json(
        { error: 'server_error', code: 'STORAGE_FAILED', detail: String(err?.message || err) },
        500,
      )
    }

    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value)
    return response
  },
}
