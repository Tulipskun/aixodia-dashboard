// Signed session cookie + password verification.
// Web Crypto only (crypto.subtle / btoa / atob) -> identical on Workers,
// Pages Functions and Node 22. No node:crypto, no KV/D1/DO, no dependencies.
//
// Cookie: axd_session=<payloadB64url>.<sigB64url>
//   payload = { u, iat, exp, v, nonce }
//   sig     = HMAC-SHA256(SESSION_SECRET, payloadB64url)
//
// Password: env AUTH_PASSWORD_HASH = "pbkdf2$<iterations>$<saltB64url>$<hashB64url>"
//   Generate with: npm run hash:password

export const COOKIE_NAME = 'axd_session'
export const DEFAULT_SESSION_TTL_SEC = 8 * 60 * 60 // 8 hours

const enc = new TextEncoder()
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_KEY_LEN_BITS = 256

// ---------- base64url (small payloads only; avoids Buffer/node) ----------

function bytesToB64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function strToB64url(s) {
  return bytesToB64url(enc.encode(s))
}

// Constant-time comparison: never early-return, fold length difference in.
export function timingSafeEqual(a, b) {
  const x = a instanceof Uint8Array ? a : enc.encode(String(a))
  const y = b instanceof Uint8Array ? b : enc.encode(String(b))
  const len = Math.max(x.length, y.length)
  let diff = x.length ^ y.length
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0)
  return diff === 0
}

// ---------- HMAC session ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

export async function signSession(payload, secret) {
  const body = strToB64url(JSON.stringify(payload))
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return `${body}.${bytesToB64url(sig)}`
}

export async function verifySession(token, secret, expected = {}) {
  if (!secret || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null

  let givenSig
  try {
    givenSig = b64urlToBytes(parts[1])
  } catch {
    return null
  }

  let expectedSig
  try {
    const key = await hmacKey(secret)
    expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(parts[0])))
  } catch {
    return null
  }

  // ALWAYS compute + compare before decoding the payload (no early return).
  const sigOk = timingSafeEqual(givenSig, expectedSig)

  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (!sigOk) return null

  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(payload.exp) || payload.exp <= now) return null
  if (expected.username && payload.u !== expected.username) return null
  if (expected.version !== undefined && payload.v !== expected.version) return null
  if (typeof payload.u !== 'string' || !payload.u) return null
  return payload
}

// ---------- PBKDF2 password ----------

async function pbkdf2(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    PBKDF2_KEY_LEN_BITS,
  )
  return new Uint8Array(bits)
}

export async function derivePasswordHash(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false
  let salt, expected
  try {
    salt = b64urlToBytes(parts[2])
    expected = b64urlToBytes(parts[3])
  } catch {
    return false
  }
  try {
    const actual = await pbkdf2(password, salt, iterations)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ---------- cookies ----------

export function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function cookieFlags(url, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : ''
  return `Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`
}

export function sessionCookieValue(token, url, maxAge = DEFAULT_SESSION_TTL_SEC) {
  return `${COOKIE_NAME}=${token}; ${cookieFlags(url, maxAge)}`
}

export function clearSessionCookie(url) {
  return `${COOKIE_NAME}=; ${cookieFlags(url, 0)}`
}

// ---------- env helpers ----------

export function authConfig(env = {}) {
  return {
    secret: String(env.SESSION_SECRET || '').trim(),
    username: String(env.AUTH_USERNAME || '').trim(),
    passwordHash: String(env.AUTH_PASSWORD_HASH || '').trim(),
    ttlSec: Number(env.SESSION_TTL_SEC) > 0 ? Number(env.SESSION_TTL_SEC) : DEFAULT_SESSION_TTL_SEC,
    version: Number(env.SESSION_VERSION) || 1,
  }
}

export function authConfigured(cfg) {
  return Boolean(cfg.secret && cfg.username && cfg.passwordHash)
}

export async function sessionFrom(request, env = {}) {
  const cfg = authConfig(env)
  if (!authConfigured(cfg)) return null
  const cookies = parseCookies(request.headers.get('cookie'))
  return verifySession(cookies[COOKIE_NAME], cfg.secret, {
    username: cfg.username,
    version: cfg.version,
  })
}

export async function issueSessionCookie(username, env, url) {
  const cfg = authConfig(env)
  const now = Math.floor(Date.now() / 1000)
  const nonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(8)))
  const payload = {
    u: username,
    iat: now,
    exp: now + cfg.ttlSec,
    v: cfg.version,
    nonce,
  }
  const token = await signSession(payload, cfg.secret)
  return { cookie: sessionCookieValue(token, url, cfg.ttlSec), expiresAt: new Date(payload.exp * 1000).toISOString() }
}

// ---------- CSRF ----------

/** POST requests must be JSON and come from our own origin. */
export function csrfCheck(request, url) {
  const origin = request.headers.get('origin')
  if (!origin || origin !== url.origin) {
    return { ok: false, code: 'CSRF_REJECTED', message: 'Origin ไม่ตรงกับต้นทางของ console' }
  }
  const ct = request.headers.get('content-type') || ''
  if (!ct.toLowerCase().includes('application/json')) {
    return { ok: false, code: 'CSRF_REJECTED', message: 'Content-Type ต้องเป็น application/json' }
  }
  return { ok: true }
}

// ---------- best-effort in-memory login rate limiting ----------
// Per-isolate only (Workers/Pages restarts reset it). Not an audit trail.
const attempts = new Map()
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 5

export function checkRateLimit(key, now = Date.now()) {
  const rec = attempts.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS }
  if (now > rec.resetAt) {
    rec.count = 0
    rec.resetAt = now + RATE_WINDOW_MS
  }
  if (rec.count >= RATE_MAX) {
    attempts.set(key, rec)
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) }
  }
  return { allowed: true, record: rec, key, now }
}

export function noteFailedLogin(key, now = Date.now()) {
  const rec = attempts.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS }
  if (now > rec.resetAt) {
    rec.count = 0
    rec.resetAt = now + RATE_WINDOW_MS
  }
  rec.count += 1
  attempts.set(key, rec)
  // opportunistic cleanup
  if (attempts.size > 500) {
    for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k)
  }
}

export function clearLoginAttempts(key) {
  attempts.delete(key)
}

export function resetRateLimitState() {
  attempts.clear()
}
